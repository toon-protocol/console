import type { ChannelStore } from '@toon-protocol/client';

import { channelStoreFor } from './channel-store.js';
import type { ChainSeedStore, PayerKeys } from './chain-seed.js';
import type { ConnectorHealth } from './connector-health.js';
import { continuationFor, mintRequestId, mintRootSecret } from './continuation.js';
import type { DirectoryResult, ListingView, ProviderView } from './directory.js';
import { resolveRpc } from './funding.js';
import {
  LeaseVaultError,
  type LeaseAccess,
  type LeaseVault,
  type LeaseView,
  type VaultedLease,
} from './lease-vault.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import type { RelayWriteTargets } from './relay-write.js';
import {
  buildSpawnContent,
  DIGEST,
  ENV_NAME,
  HEX_32,
  SSH_PUBLIC_KEY,
  type SpawnContent,
  type SpawnImage,
  type SpawnPort,
} from './spawn-content.js';
import type { TemplateSpawnRequest } from './template-spawn.js';

/**
 * **Buying a lease**: the console's first paid provider route
 * (TOON_Network#92, spec §6.1 and §6.2).
 *
 * Everything before this ticket was free. Reading the Provider Directory costs
 * nothing, reading Templates costs nothing, `GET /ilp` costs nothing, and
 * opening a channel spends the account's own money on its own chain. A spawn
 * is the first thing the console does that hands µUSDC to somebody else, and
 * four facts shape this module.
 *
 * **A refused request is still billed (ADR 0003, TOON_Network#115).** TOON
 * bills for *an answer*, so a malformed Lease Request costs an interval and
 * buys nothing. Everything checkable is therefore checked HERE, before a
 * packet goes out: the image's form, the ports, the volume against the
 * listing's storage, the SSH key, the provider key's spelling. `preflight` is
 * that check with no send at the end of it, so a person can see what a spawn
 * would cost and what is wrong with it without paying to find out.
 *
 * **The Root Secret goes into the Lease Vault first (ADR 0021).** Not after
 * the answer, and not "as well": the record is published, and only then is the
 * spawn sent. A vault write that no relay accepted aborts the spawn, and
 * nothing is paid. See `lease-vault.ts` for why that ordering is the whole
 * point.
 *
 * **There is ONE spawn content, and this module does not build it.**
 * `spawn-content.ts`'s `buildSpawnContent` does, for the manual path here and
 * for the Template path in `template-spawn.ts` alike (#94). What this module
 * owns is what a content is *checked against* — a Listing, a channel, a
 * provider's Profile — and what it is then wrapped in: §6.1's Lease Request,
 * the Continuation Token, the sealed envelope and the payment.
 *
 * **Where the packet is paid is read, never assumed.** A spawn is addressed to
 * the provider's own ILP route and sealed to its connector's pinned key (§4.1,
 * ADR 0011). WHICH connector collects is a routing question, answered from the
 * two self-descriptions the console can read: if the active profile's
 * connector publishes a route that carries the provider's prefix, the packet
 * goes through it — the tenant's own connector, paying through hops, which is
 * what ADR 0005 describes. If it does not, the packet is paid at the
 * provider's own connector, which always terminates its own routes. On the
 * local sandbox the first is true (the hub carries `g.toon.provider.*`); on
 * devnet today the second is, because the relay connector publishes no route
 * to the provider and peers with nobody. Neither is hard-coded, and a devnet
 * that grows a peering changes which one applies with no release here.
 */

/** §7.2: a provider refuses a Lease Request whose `expiration` is further off. */
export const REQUEST_WINDOW_S = 300;

/**
 * How far ahead this console sets `expiration`.
 *
 * Inside the window with room to spare, because the window is checked against
 * the PROVIDER's clock and the two are not the same clock. A console running a
 * minute fast would have every one of its requests refused as `stale_request`
 * — billed, on a paid route — for no fault a person could see.
 */
export const REQUEST_TTL_S = 240;

/**
 * An OCI repository with no tag and no `@digest` (§6.2).
 *
 * Deliberately loose about the registry host and strict about the two things
 * the spec forbids, because a `reference` carrying its own tag is the mistake
 * a person actually makes — `traefik/whoami:latest` — and the provider answers
 * it with `invalid_request` after billing for the privilege.
 */
const OCI_REFERENCE = /^[a-z0-9]+([._:\-/][a-z0-9]+)*$/iu;

export class LeaseError extends Error {
  readonly code: string;
  readonly status: number;
  /** The provider's own words, when the refusal came from the provider. */
  readonly providerError?: string | undefined;
  readonly relays?: LeaseVaultError['relays'];
  constructor(
    code: string,
    message: string,
    status = 400,
    detail: { providerError?: string; relays?: LeaseVaultError['relays'] } = {}
  ) {
    super(message);
    this.name = 'LeaseError';
    this.code = code;
    this.status = status;
    if (detail.providerError !== undefined) this.providerError = detail.providerError;
    if (detail.relays) this.relays = detail.relays;
  }
}

/* -------------------------------------------------------------------------- */
/* What a person asks for                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A spawn typed into a form rather than expanded from a Template.
 *
 * camelCase, because it is the console's own API and everything else on that
 * surface is. It is translated into §6.2's snake_case exactly once, by
 * `buildSpawnContent`, which is also where the Template path arrives.
 */
export interface SpawnRequest {
  /** The provider's Nostr key, 64 lowercase hex, as its Profile publishes it. */
  readonly provider: string;
  /** The Listing's `d` name, or its `30432:<pubkey>:<name>` address. */
  readonly listing: string;
  readonly image: {
    readonly reference?: string | undefined;
    readonly digest: string;
    readonly registryEntry?:
      { readonly address: string; readonly relay?: string | undefined } | undefined;
  };
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly ports?: readonly { containerPort: number; protocol?: 'tcp' | 'udp' }[] | undefined;
  readonly sshPublicKey: string;
  readonly volumeGb?: number | undefined;
  readonly entrypoint?: readonly string[] | undefined;
  readonly args?: readonly string[] | undefined;
  /** Keep the Root Secret on this machine and publish nothing (ADR 0021). */
  readonly localOnly?: boolean | undefined;
  /** Fixed by a test or a retry; chosen at random otherwise. */
  readonly workloadId?: string | undefined;
  /**
   * Which settlement chain to pay on, as the connector names it.
   *
   * Absent takes the first chain the paying connector settles on that this
   * account holds a channel with, which is right when there is only one. It is
   * not always right when there are two, and the reason is a fact the console
   * cannot read anywhere: a connector forwarding to a provider's connector has
   * to convert, and it refuses a packet whose amount converts to nothing at
   * the rate it declares — so a channel on the "wrong" chain buys a refusal at
   * full price. The refusal names the currency the far peer wants, and this is
   * how a person acts on it.
   */
  readonly chain?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* The provider port                                                          */
/* -------------------------------------------------------------------------- */

export interface LeasePacket {
  /** The connector edge whose channel pays for this packet. */
  readonly payAt: string;
  /** The TERMINATING connector's pinned sealing key (§4.1, ADR 0011). */
  readonly sealTo: string;
  /** The ILP destination: `<addr>.<listing>.v<n>.spawn` (§5). */
  readonly route: string;
  readonly body: unknown;
  readonly chainKind: 'evm' | 'solana';
  readonly rpcUrl: string;
  readonly keys: PayerKeys;
  readonly channelStore: ChannelStore;
  readonly timeoutMs?: number | undefined;
}

/**
 * What came back, in the three kinds a caller must tell apart.
 *
 * The distinction is not stylistic: it decides whether the vault record is
 * taken back. `answered` and `refused` are DEFINITIVE — the provider, or the
 * connector that terminates its routes, decided — so a lease that did not
 * start definitely did not start. `unknown` is a packet whose fate nobody
 * reported: a timeout, a socket that died mid-flight. A lease may be running
 * behind one, so its Root Secret is kept.
 */
export type PacketOutcome =
  | {
      readonly kind: 'answered';
      readonly status: number;
      readonly body: unknown;
      readonly text: string;
      /** What this packet cost, in base units, when a claim was signed. */
      readonly cost?: string | undefined;
      readonly channelId?: string | undefined;
    }
  | {
      readonly kind: 'refused';
      readonly code: string;
      readonly refusedBy: 'destination' | 'path' | 'edge';
      readonly message: string;
      readonly cost?: string | undefined;
    }
  | { readonly kind: 'unknown'; readonly message: string };

export interface ProviderPort {
  send(packet: LeasePacket): Promise<PacketOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

export interface PreflightView {
  readonly ok: boolean;
  /** Everything wrong with this request, all of it, before anything is paid. */
  readonly problems: readonly string[];
  readonly provider?:
    | {
        readonly pubkey: string;
        readonly ilpAddress: string;
        readonly connectorUrl: string;
        readonly hidden: boolean;
        readonly liveness: string;
      }
    | undefined;
  readonly listing?:
    | {
        readonly name: string;
        readonly version: number;
        readonly leaseIntervalSeconds: number;
        /** µUSDC for one Lease Interval, as the Listing priced it. */
        readonly price: number;
        readonly capabilities: readonly string[];
      }
    | undefined;
  readonly route?: string | undefined;
  /** Which connector's channel pays, and why that one. */
  readonly payment?:
    | {
        readonly connectorUrl: string;
        readonly via: 'profile-connector' | 'provider-connector';
        readonly reason: string;
        readonly chain?: string | undefined;
        readonly channelId?: string | undefined;
        readonly routePrice?: string | undefined;
      }
    | undefined;
  /**
   * Where the Root Secret would be written, what that write costs, and what
   * stops it — before a packet goes out.
   *
   * The vault write is itself a paid packet now (TOON_Network#120), so a spawn
   * has two prices: the Listing's interval and one relay write. Both are shown
   * here, and both are the connector's or the provider's own figures.
   */
  readonly vault: {
    readonly localOnly: boolean;
    readonly writes: RelayWriteTargets;
  };
}

export interface SpawnResult {
  readonly lease?: LeaseView | undefined;
  readonly preflight: PreflightView;
  /** The provider's answer, verbatim, when it gave one. */
  readonly answer?: unknown;
  /** What the packet cost, in base units of the settlement token. */
  readonly cost?: string | undefined;
  /** Set when a successful spawn's confirmation could not be published. */
  readonly confirmationFailed?: string | undefined;
}

export interface LeaseStoreDeps {
  readonly profile: () => NetworkProfile;
  readonly vault: LeaseVault;
  readonly chainSeed: ChainSeedStore;
  readonly readHealth: (profile: NetworkProfile) => Promise<ConnectorHealth>;
  readonly readDirectory: (profile: NetworkProfile) => Promise<DirectoryResult>;
  readonly provider: ProviderPort;
  readonly paths: ConsolePaths;
  readonly now?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
}

/** What a spawn is bought on, whoever assembled its content. */
interface Selection {
  readonly provider: string;
  /** A Listing's `d` name, or its `30432:<pubkey>:<name>` address. */
  readonly listing: string;
  /** The version the caller chose, when it chose one (§4.2, ADR 0009). */
  readonly listingVersion?: number | undefined;
  readonly localOnly: boolean;
  /** The settlement chain to pay on, when the caller named one. */
  readonly chain?: string | undefined;
}

export class LeaseStore {
  readonly #deps: LeaseStoreDeps;

  constructor(deps: LeaseStoreDeps) {
    this.#deps = deps;
  }

  /**
   * Everything a spawn would do, with nothing spent.
   *
   * The answer to TOON_Network#115 as a surface rather than a rule: a person
   * sees the route, the price, which connector's channel pays and every
   * problem with the request, and none of it costs an interval to learn.
   */
  async preflight(request: SpawnRequest): Promise<PreflightView> {
    const problems: string[] = [];
    const content = manualContent(request, problems);
    return (await this.#plan(selectionOf(request), content, problems)).view;
  }

  /**
   * Buy a lease from a form: vault the Root Secret, then send one paid packet.
   *
   * @throws {LeaseError} before anything is paid, when the request is wrong,
   *   when there is no channel to pay from, or when the vault record could not
   *   be published.
   */
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const problems: string[] = [];
    const content = manualContent(request, problems);
    const plan = await this.#plan(selectionOf(request), content, problems);
    return this.#buy(plan, request.localOnly === true);
  }

  /**
   * Buy a lease from an expanded Template (#94's seam, spec §8.3).
   *
   * The content arrives already built — by the same `buildSpawnContent` the
   * form path uses — and nothing in it is reinterpreted here. What this adds
   * is what buying anything needs: the Listing it is bought on, a Root Secret,
   * the Continuation Token, the vault record and the payment. That is why
   * "spawning from a Template produces the same result as the equivalent
   * manual spawn" holds by construction: the two paths differ only in who
   * filled the fields in.
   */
  async spawnFromTemplate(request: TemplateSpawnRequest): Promise<SpawnResult> {
    const problems: string[] = [];
    const plan = await this.#plan(
      {
        provider: request.provider,
        listing: request.listing,
        localOnly: request.localOnly === true,
        ...(request.listingVersion === undefined
          ? {}
          : { listingVersion: request.listingVersion }),
      },
      request.content,
      problems
    );
    return this.#buy(plan, request.localOnly === true);
  }

  /* ------------------------------------------------------------------------ */

  async #buy(plan: Plan, localOnly: boolean): Promise<SpawnResult> {
    if (!plan.ready) {
      throw new LeaseError(
        plan.view.problems.some((problem) => problem.startsWith('No payment channel'))
          ? 'no_channel'
          : 'invalid_request',
        `This spawn was not sent, and nothing was paid. ${plan.view.problems.join(' ')}`,
        plan.view.problems.some((problem) => problem.startsWith('No payment channel'))
          ? 409
          : 400
      );
    }

    const { ready } = plan;
    const rootSecret = mintRootSecret();
    const record: VaultedLease = {
      v: 1,
      state: 'spawning',
      workload_id: ready.content.workload_id,
      root_secret: rootSecret,
      standby_set: ready.content.standby_set ?? [ready.provider.pubkey],
      provider: {
        pubkey: ready.provider.pubkey,
        ilp_address: ready.provider.profile.ilpAddress,
        connector_url: ready.provider.profile.connectorUrl,
        connector_seal_key: ready.provider.profile.connectorSealKey,
        ...(ready.provider.profile.hidden ? { hidden: true } : {}),
      },
      paid_at: ready.payAt,
      listing: {
        name: ready.listing.name,
        version: ready.listing.version,
        address: ready.listing.address,
        lease_interval_s: ready.listing.leaseIntervalSeconds,
        price: ready.listing.price,
      },
      profile_id: this.#deps.profile().id,
      image: ready.content.image,
      ports: ready.content.ports,
      env_keys: Object.keys(ready.content.env),
      created_at: this.#at().toISOString(),
      ...(ready.content.template === undefined ? {} : { template: ready.content.template }),
      ...(localOnly ? { local_only: true } : {}),
    };

    // BEFORE the packet. A vault write that no relay took throws here, and the
    // spawn is never sent (ADR 0021).
    await this.#deps.vault.publish(record).catch((error: unknown) => {
      if (error instanceof LeaseVaultError) {
        throw new LeaseError(error.code, error.message, error.status, {
          ...(error.relays ? { relays: error.relays } : {}),
        });
      }
      throw error;
    });

    const body = {
      request: {
        request_id: mintRequestId(),
        op: 'spawn' as const,
        provider: ready.provider.pubkey,
        expiration: this.#seconds() + REQUEST_TTL_S,
        // A spawn carrying no `continuation` is `invalid_request` (§6.1.2): it
        // would buy a lease nobody could ever read, extend or stop.
        continuation: continuationFor(rootSecret, ready.provider.pubkey),
        content: ready.content,
      },
    };

    // A throw here is a spawn that never left: borrowing the payer keys failed,
    // or a remote signer refused. Nothing was paid and no lease exists, so the
    // record that was just published must go — otherwise the one state this
    // vault must never be in, a record with no lease behind it, is exactly
    // where a failed borrow leaves it.
    let outcome: PacketOutcome;
    try {
      outcome = await this.#deps.chainSeed.usePayerKeys((keys) =>
        this.#deps.provider.send({
          payAt: ready.payAt,
          sealTo: ready.sealTo,
          route: ready.route,
          body,
          chainKind: ready.chainKind,
          rpcUrl: ready.rpcUrl,
          keys,
          channelStore: ready.channelStore,
          ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
        })
      );
    } catch (error) {
      await this.#deps.vault.retract(
        ready.content.workload_id,
        'the spawn was never sent: the payer keys could not be borrowed'
      );
      throw error;
    }

    return this.#settle(ready.content.workload_id, plan.view, outcome);
  }

  /**
   * Turn one packet's outcome into a lease, or take the record back.
   *
   * The three branches are the three kinds of outcome, and the middle one is
   * the interesting one: a provider that answered `{ "error": … }` on a paid
   * route took the money and refused the request (§5). The lease does not
   * exist, so the record must not either — and the provider's own reason is
   * what a person is shown, not a sentence this console made up about it.
   */
  async #settle(
    workloadId: string,
    view: PreflightView,
    outcome: PacketOutcome
  ): Promise<SpawnResult> {
    if (outcome.kind === 'unknown') {
      // NOT retracted. A packet nobody reported on may have started a
      // workload, and a deleted Root Secret is a lease that can never be
      // stopped — the one failure this vault exists to prevent.
      throw new LeaseError(
        'spawn_unconfirmed',
        `The spawn was sent and nothing came back: ${outcome.message} The lease record is kept, ` +
          `because a workload may be running behind it and its Root Secret is the only thing ` +
          `that could ever stop it. Ask the provider for its status before spawning again.`,
        504
      );
    }

    if (outcome.kind === 'refused') {
      const taken = await this.#deps.vault.retract(
        workloadId,
        `the spawn was refused: ${outcome.code}`
      );
      throw new LeaseError(
        'spawn_refused',
        `${describeRefusal(outcome)} The lease record was taken back, so nothing is left ` +
          `pointing at a lease that does not exist.` +
          (taken.retracted
            ? ''
            : ` The record could NOT be taken back: ${taken.reason ?? ''}`) +
          (outcome.cost === undefined
            ? ''
            : ` This still cost ${outcome.cost} base units: TOON bills for an answer, and a ` +
              `refusal is one (ADR 0003).`),
        502,
        { providerError: outcome.code }
      );
    }

    const answered = readSpawnAnswer(outcome.body);
    if (answered.error !== undefined || outcome.status !== 200) {
      const taken = await this.#deps.vault.retract(
        workloadId,
        `the provider refused the spawn: ${answered.error ?? outcome.status}`
      );
      throw new LeaseError(
        'spawn_refused',
        `The provider refused this spawn: ${answered.error ?? `HTTP ${outcome.status}`}. ` +
          `${answered.message ?? outcome.text.slice(0, 400)} The lease record was taken back.` +
          (outcome.cost === undefined
            ? ''
            : ` It was still billed ${outcome.cost} base units — a paid route bills for an ` +
              `answer, and a refusal is one (ADR 0003, spec §5).`) +
          (taken.retracted
            ? ''
            : ` The record could NOT be taken back: ${taken.reason ?? ''}`),
        502,
        { providerError: answered.error ?? `HTTP ${outcome.status}` }
      );
    }

    if (answered.workloadId !== workloadId) {
      // The provider answered about a lease this console did not buy. Keep the
      // record: something is running and this secret is what stops it.
      throw new LeaseError(
        'wrong_workload',
        `The provider answered about workload ${answered.workloadId ?? 'nothing'}, not the one ` +
          `this spawn asked for. The lease record is kept, because the Root Secret is the only ` +
          `thing that could stop whatever was started.`,
        502
      );
    }

    const confirmed = await this.#deps.vault.confirm(workloadId, {
      ...(answered.role === undefined ? {} : { role: answered.role }),
      ...(answered.expiresAt === undefined ? {} : { expires_at: answered.expiresAt }),
      ...(answered.access === undefined ? {} : { access: answered.access }),
    });

    const lease = this.#deps.vault.find(workloadId);
    return {
      ...(lease === undefined ? {} : { lease }),
      preflight: view,
      answer: outcome.body,
      ...(outcome.cost === undefined ? {} : { cost: outcome.cost }),
      ...(confirmed.confirmed ? {} : { confirmationFailed: confirmed.reason ?? 'unknown' }),
    };
  }

  /* ------------------------------------------------------------------------ */
  /* The plan                                                                 */
  /* ------------------------------------------------------------------------ */

  async #plan(
    selection: Selection,
    content: SpawnContent | undefined,
    problems: string[]
  ): Promise<Plan> {
    const profile = this.#deps.profile();
    // `targets`, not `status`: a preflight must say where the Root Secret
    // would REALLY go, and that answer needs the account's NIP-65 list to have
    // been read at least once.
    const targets = await this.#deps.vault.targets();
    const vault = { localOnly: selection.localOnly, writes: targets };
    const unready = (): Plan => ({ ready: undefined, view: { ok: false, problems, vault } });

    // The vault record is a paid write of its own (#120), and it goes out
    // BEFORE the spawn. A spawn that would fail at that write is stopped here,
    // where it costs nothing to learn — not after a Root Secret has been
    // minted, and never after an interval has been paid for.
    if (!selection.localOnly && !targets.ready) {
      problems.push(
        `The Root Secret cannot be vaulted, so this spawn would not be sent: ` +
          `${targets.blockedBy ?? 'no relay write can be bought right now.'} Mark this lease ` +
          `"local only" if you would rather one machine held its secret.`
      );
    }

    if (!isConfigured(profile)) {
      problems.push(`${profile.label} names no connector, so nothing can be paid on it.`);
      return unready();
    }
    // The payer keys come from the Chain Seed, and a store that has not LOOKED
    // for one yet reports `unknown` — which is not `absent`. Asking here means
    // a preflight says "this account has no Chain Seed" before a person fills
    // in a form, rather than a spawn failing after the vault record is already
    // published.
    const seed = await this.#seed();
    // `not_yet_recoverable` is a seed too: its payer keys are real and the
    // channel this spawn pays from was opened with one of them (#120). What is
    // at risk while it is held is the MONEY, not this lease — the vault record
    // is sealed to the account's Nostr key and comes back anywhere — and the
    // Funds tab is where that is said, in full.
    if (seed.state !== 'ready' && seed.state !== 'not_yet_recoverable') {
      problems.push(
        seed.state === 'signed_out'
          ? 'No account is signed in, so there is no key to pay with and none to seal a Root ' +
              'Secret to.'
          : (seed.reason ??
              'This account has no readable Chain Seed, so it has no payer key on any chain. ' +
                'Mint or import one on the Account tab.')
      );
      return unready();
    }

    if (!HEX_32.test(selection.provider)) {
      problems.push(
        'A provider is named by its Nostr key: 64 lowercase hex characters, exactly as its ' +
          'Profile publishes it. The key is spelled into the Continuation Token’s derivation, ' +
          'so any other spelling derives a token the provider does not hold (spec §6.1.1).'
      );
      return unready();
    }

    const directory = await this.#deps.readDirectory(profile);
    if (directory.state !== 'ok') {
      problems.push(`The Provider Directory could not be read: ${directory.reason}`);
      return unready();
    }
    const provider = directory.providers.find(
      (candidate) => candidate.pubkey === selection.provider
    );
    if (!provider) {
      problems.push(
        `No provider with that key has a current Profile on ${profile.label}'s relays, so ` +
          'nothing says where its connector is or which key to seal to (spec §4.2).'
      );
      return unready();
    }
    const wanted = listingNameOf(selection.listing);
    const listing = provider.listings.find((candidate) => candidate.name === wanted);
    if (!listing) {
      problems.push(
        `That provider publishes no current Listing named ${JSON.stringify(wanted)}. ` +
          `It sells ${provider.listings.map((entry) => entry.name).join(', ') || 'nothing'}.`
      );
      return unready();
    }
    if (
      selection.listingVersion !== undefined &&
      selection.listingVersion !== listing.version
    ) {
      // A price or resource change is a NEW version (ADR 0009), and a spawn on
      // a retired one is refused `wrong_listing_version` — after being billed.
      problems.push(
        `That Listing has been republished at v${listing.version}; this spawn names ` +
          `v${selection.listingVersion}. A version change is a price or resource change ` +
          `(ADR 0009), and the old route may not be on sale at all — so choose the tier again ` +
          `rather than buy at a figure that has moved.`
      );
      return unready();
    }

    if (content !== undefined) {
      checkContent(content, listing, problems);
      // Free, and the provider charges an interval to say the same thing
      // (`workload_id_taken`, §6.2 step 4). It is also how this account's own
      // vault is protected: a second record under one workload id would
      // replace the first one's Root Secret.
      const already = this.#deps.vault.find(content.workload_id);
      if (already !== undefined) {
        problems.push(
          `This account already holds a lease with workload id ${content.workload_id}, ` +
            `spawned ${already.createdAt} on ${already.provider.ilp_address}. A workload id is ` +
            '32 random bytes chosen per lease: leave it out and one is chosen.'
        );
      }
    }

    const route = `${provider.profile.ilpAddress}.${listing.name}.v${listing.version}.spawn`;
    const payment = await this.#payment(profile, provider, route, selection, problems);

    const view: PreflightView = {
      ok: problems.length === 0,
      problems,
      provider: {
        pubkey: provider.pubkey,
        ilpAddress: provider.profile.ilpAddress,
        connectorUrl: provider.profile.connectorUrl,
        hidden: provider.profile.hidden,
        liveness: provider.liveness.state,
      },
      listing: {
        name: listing.name,
        version: listing.version,
        leaseIntervalSeconds: listing.leaseIntervalSeconds,
        price: listing.price,
        capabilities: listing.capabilities,
      },
      route,
      ...(payment === undefined ? {} : { payment: payment.view }),
      vault,
    };

    if (problems.length > 0 || content === undefined || payment === undefined) {
      return { ready: undefined, view };
    }

    return {
      view,
      ready: {
        provider,
        listing,
        route,
        content,
        payAt: payment.payAt,
        sealTo: provider.profile.connectorSealKey,
        chainKind: payment.chainKind,
        rpcUrl: payment.rpcUrl,
        channelStore: payment.channelStore,
      },
    };
  }

  /**
   * Which connector collects for this packet, on which chain, from which
   * channel — all of it read rather than assumed.
   *
   * The profile's connector is preferred when it publishes a route that
   * carries this prefix, because that is the tenant's own connector and the
   * one the funding view already knows about. Otherwise the provider's own
   * connector, which terminates its own routes by definition. A channel must
   * already exist at whichever it is: a spawn must never open one as a side
   * effect, because opening locks collateral and pays gas, and neither is a
   * thing to do to somebody who pressed "spawn".
   */
  async #payment(
    profile: NetworkProfile,
    provider: ProviderView,
    route: string,
    selection: Selection,
    problems: string[]
  ): Promise<ResolvedPayment | undefined> {
    const own = await this.#deps.readHealth(profile);
    const carries =
      own.state === 'ok' &&
      own.routes.some((published) => routeCarries(published.prefix, route));
    const payAt = carries ? profile.connectorUrl : provider.profile.connectorUrl;
    const via = carries ? ('profile-connector' as const) : ('provider-connector' as const);
    const reason = carries
      ? `${profile.label}'s own connector publishes a route that carries ${route}, so the ` +
        `packet is paid there and forwarded (ADR 0005).`
      : `${profile.label}'s connector publishes no route carrying ${route}, so the packet is ` +
        `paid at the provider's own connector, which terminates it (spec §4.1, §5).`;

    if (payAt.length === 0) {
      problems.push('That provider publishes no connector URL, so there is nowhere to pay.');
      return undefined;
    }
    if (isHiddenServiceUrl(payAt)) {
      // The client reaches a `.anyone` connector only through a running Anyone
      // Protocol daemon's SOCKS port, which this console does not start yet
      // (TOON_Network#96). Saying so is better than a packet that cannot leave.
      problems.push(
        `The connector at ${payAt} is a hidden service, and reaching one needs a running ` +
          `Anyone Protocol daemon to proxy through. The console does not start one yet, so ` +
          `spawning on a Hidden Provider is not available on this build (spec §10).`
      );
      return undefined;
    }

    const health = carries
      ? own
      : await this.#deps.readHealth({ ...profile, connectorUrl: payAt });
    if (health.state !== 'ok') {
      problems.push(
        `The connector at ${payAt} did not answer, so neither what it settles in nor what this ` +
          `route costs can be read. ${health.state === 'unreachable' ? health.reason : ''}`.trim()
      );
      return undefined;
    }

    const routePrice = health.routes.find((published) =>
      routeCarries(published.prefix, route)
    )?.price;

    const settlements =
      selection.chain === undefined
        ? health.settlements
        : health.settlements.filter((entry) => entry.chain === selection.chain);
    if (settlements.length === 0) {
      problems.push(
        `The connector at ${payAt} does not settle on ${JSON.stringify(selection.chain)}. It ` +
          `settles on ${health.settlements.map((entry) => entry.chain).join(', ') || 'nothing'}.`
      );
      return undefined;
    }

    const channels = channelStoreFor(this.#deps.paths, profile.id);
    const bindings = channels.store.listBindings?.() ?? [];
    for (const settlement of settlements) {
      const binding = bindings.find(
        (entry) =>
          entry.binding.supersededAt === undefined &&
          entry.key.split('|')[1] === settlement.chain &&
          sameConnector(entry.key.split('|')[0] ?? '', payAt)
      );
      if (!binding) continue;
      const rpc = resolveRpc(profile, settlement.kind);
      return {
        payAt,
        chainKind: settlement.kind,
        rpcUrl: rpc.url,
        channelStore: channels.store,
        view: {
          connectorUrl: payAt,
          via,
          reason,
          chain: settlement.chain,
          channelId: binding.binding.channelId,
          ...(routePrice === undefined ? {} : { routePrice }),
        },
      };
    }

    problems.push(
      `No payment channel with the connector at ${payAt}. A spawn pays from a channel and must ` +
        `never open one for you — opening locks collateral on chain and costs the chain's own ` +
        `gas. Open one on ${settlements.map((entry) => entry.chain).join(' or ')} from ` +
        `the Funds tab, naming this connector.`
    );
    return {
      payAt,
      chainKind: settlements[0]?.kind ?? 'evm',
      rpcUrl: resolveRpc(profile, settlements[0]?.kind ?? 'evm').url,
      channelStore: channels.store,
      view: {
        connectorUrl: payAt,
        via,
        reason,
        ...(routePrice === undefined ? {} : { routePrice }),
      },
    };
  }

  /**
   * The Chain Seed's state — having actually LOOKED for it.
   *
   * The same care `FundingStore` takes, for the same reason: `unknown` is not
   * `absent`, and telling somebody they have no Chain Seed because nothing had
   * asked their relays yet is how a second seed gets minted over a first
   * (ADR 0020).
   */
  async #seed() {
    const held = this.#deps.chainSeed.status();
    if (held.state !== 'unknown') return held;
    try {
      return await this.#deps.chainSeed.refresh();
    } catch {
      return this.#deps.chainSeed.status();
    }
  }

  #at(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }

  #seconds(): number {
    return Math.floor(this.#at().getTime() / 1000);
  }
}

interface ResolvedPayment {
  readonly payAt: string;
  readonly chainKind: 'evm' | 'solana';
  readonly rpcUrl: string;
  readonly channelStore: ChannelStore;
  readonly view: NonNullable<PreflightView['payment']>;
}

interface ReadyPlan {
  readonly provider: ProviderView;
  readonly listing: ListingView;
  readonly route: string;
  readonly content: SpawnContent;
  readonly payAt: string;
  readonly sealTo: string;
  readonly chainKind: 'evm' | 'solana';
  readonly rpcUrl: string;
  readonly channelStore: ChannelStore;
}

interface Plan {
  readonly view: PreflightView;
  readonly ready?: ReadyPlan | undefined;
}

function selectionOf(request: SpawnRequest): Selection {
  return {
    provider: request.provider,
    listing: request.listing,
    localOnly: request.localOnly === true,
    ...(request.chain === undefined ? {} : { chain: request.chain }),
  };
}

/** A Listing named by its `d`, or by its `30432:<pubkey>:<name>` address (§4.2). */
export function listingNameOf(listing: string): string {
  const parts = listing.split(':');
  return parts.length >= 3 && parts[0] === '30432' ? parts.slice(2).join(':') : listing;
}

/* -------------------------------------------------------------------------- */
/* Reading what a person typed                                                */
/* -------------------------------------------------------------------------- */

/**
 * A form's fields, translated into §6.2's content by the ONE builder.
 *
 * Everything this does is rename and shape: the checks that matter — the
 * image's one-of rule, the ports, the volume against a Listing — happen in
 * `checkContent` below, over the wire shape, so that a Template's content and
 * a form's are held to exactly the same standard.
 */
export function manualContent(
  request: SpawnRequest,
  problems: string[]
): SpawnContent | undefined {
  const workloadId = request.workloadId?.trim();
  if (workloadId !== undefined && !HEX_32.test(workloadId)) {
    problems.push('A workload id is 32 bytes as 64 lowercase hex characters (spec §6.2).');
    return undefined;
  }

  const image = readImage(request.image, problems);
  const ports = readPorts(request.ports, problems);
  if (image === undefined) return undefined;

  return buildSpawnContent({
    ...(workloadId === undefined ? {} : { workloadId }),
    image,
    ...(request.env === undefined ? {} : { env: request.env }),
    ports,
    ...(request.volumeGb === undefined ? {} : { volumeGb: request.volumeGb }),
    sshPublicKey: request.sshPublicKey?.trim() ?? '',
    ...(request.entrypoint === undefined || request.entrypoint.length === 0
      ? {}
      : { entrypoint: request.entrypoint }),
    ...(request.args === undefined || request.args.length === 0 ? {} : { args: request.args }),
  });
}

/**
 * Everything a provider would refuse this content for, found for nothing.
 *
 * Run over the WIRE shape and against the Listing that is about to be bought,
 * so it applies equally to a content a form produced and one a Template
 * expanded. Every problem is collected rather than thrown at the first: a
 * person correcting a form should see all of it at once, and none of it is
 * costing anything to find out.
 */
export function checkContent(
  content: SpawnContent,
  listing: ListingView,
  problems: string[]
): void {
  if (!HEX_32.test(content.workload_id)) {
    problems.push('A workload id is 32 bytes as 64 lowercase hex characters (spec §6.2).');
  }
  if (!DIGEST.test(content.image.digest)) {
    problems.push(
      'An image digest is `sha256:` followed by exactly 64 lowercase hex characters (spec ' +
        '§6.2). It is what the provider verifies the bytes against, so a tag is not a ' +
        'substitute for one.'
    );
  }
  for (const name of Object.keys(content.env)) {
    if (!ENV_NAME.test(name)) {
      problems.push(
        `${JSON.stringify(name)} is not an environment variable name: letters, digits and ` +
          'underscores, not starting with a digit.'
      );
    }
  }
  for (const port of content.ports) {
    if (
      !Number.isInteger(port.container_port) ||
      port.container_port < 1 ||
      port.container_port > 65535
    ) {
      problems.push(
        `${String(port.container_port)} is not a container port: a whole number from 1 to 65535.`
      );
    }
    if (port.protocol !== 'tcp' && port.protocol !== 'udp') {
      problems.push(
        `A port's protocol is "tcp" or "udp" (spec §6.2), not ${String(port.protocol)}.`
      );
    }
  }
  if (content.volume_gb !== undefined) {
    if (!Number.isInteger(content.volume_gb) || content.volume_gb <= 0) {
      problems.push(
        'A persistent volume is a whole number of gigabytes above zero (spec §6.2).'
      );
    } else if (content.volume_gb > listing.resources.storageGb) {
      problems.push(
        `This listing sells ${listing.resources.storageGb} GB of storage, so a ` +
          `${content.volume_gb} GB volume does not fit it (spec §6.2). A spawn that asks for ` +
          'more is refused — and billed.'
      );
    }
  }
  checkSshKey(content.ssh_public_key, problems);
  if (content.standby_set !== undefined) {
    // §6.2 step 3: a `standby_set` present at all makes this a set member's
    // spawn, and every other member needs its own `.standby` request with its
    // own token (§7). Buying the primary's lease and leaving the reservations
    // unbought would be a Standby Set that protects nothing.
    problems.push(
      'Warm Standbys are TOON_Network#95. This console can buy the primary’s lease but not ' +
        'the reservations at the other members of the set, and a half-formed Standby Set ' +
        'protects nothing while costing an interval at every member (spec §7).'
    );
  }
}

/** §6.2's `image`, in exactly one of its three forms, from a form's fields. */
export function readImage(
  image: SpawnRequest['image'],
  problems: string[]
): SpawnImage | undefined {
  const before = problems.length;
  const digest = image.digest?.trim() ?? '';
  if (!DIGEST.test(digest)) {
    problems.push(
      'An image digest is `sha256:` followed by exactly 64 lowercase hex characters (spec ' +
        '§6.2). It is what the provider verifies the bytes against, so a tag is not a ' +
        'substitute for one.'
    );
  }
  const reference = image.reference?.trim();
  const entry = image.registryEntry;
  if (reference !== undefined && reference !== '' && entry !== undefined) {
    problems.push(
      '`reference` and `registry_entry` must not both be present (spec §6.2): one says the ' +
        'bytes come from an upstream registry, the other that they come from an Image Registry ' +
        'entry, and a spawn carrying both is refused — and billed.'
    );
    return undefined;
  }
  if (reference !== undefined && reference !== '') {
    if (reference.includes('@')) {
      problems.push(
        `\`reference\` carries no \`@digest\` (spec §6.2) — the digest is its own field. Drop ` +
          `everything from the \`@\` in ${JSON.stringify(reference)}.`
      );
    } else if (/:[^/]*$/u.test(reference) && !/^[^/]*:\d+\//u.test(reference)) {
      problems.push(
        `\`reference\` carries no tag (spec §6.2): a provider pulls \`reference@digest\`, so ` +
          `${JSON.stringify(reference)} should drop its \`:tag\`.`
      );
    } else if (!OCI_REFERENCE.test(reference)) {
      problems.push(
        `${JSON.stringify(reference)} is not an OCI repository: ` +
          '`[registry[:port]/]repo[/path…]` (spec §6.2).'
      );
    }
  }
  if (entry !== undefined && !/^30434:[0-9a-f]{64}:.+$/u.test(entry.address)) {
    problems.push(
      '`registry_entry.address` is `30434:<pubkey>:<name>:<tag>` — the entry’s own `d` keeps ' +
        'its colon, so the coordinate has four fields (spec §6.2, §8.1).'
    );
  }
  if (problems.length > before) return undefined;
  return {
    digest,
    ...(reference === undefined || reference === '' ? {} : { reference }),
    ...(entry === undefined
      ? {}
      : {
          registry_entry: {
            address: entry.address,
            ...(entry.relay === undefined || entry.relay === '' ? {} : { relay: entry.relay }),
          },
        }),
  };
}

export function readPorts(
  ports: SpawnRequest['ports'],
  problems: string[]
): readonly SpawnPort[] {
  const read: SpawnPort[] = [];
  for (const port of ports ?? []) {
    const number = port.containerPort;
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      problems.push(
        `${String(number)} is not a container port: a whole number from 1 to 65535.`
      );
      continue;
    }
    const protocol = port.protocol ?? 'tcp';
    if (protocol !== 'tcp' && protocol !== 'udp') {
      problems.push(
        `A port's protocol is "tcp" or "udp" (spec §6.2), not ${String(protocol)}.`
      );
      continue;
    }
    if (read.some((held) => held.container_port === number && held.protocol === protocol)) {
      problems.push(`Container port ${number}/${protocol} is named twice.`);
      continue;
    }
    read.push({ container_port: number, protocol });
  }
  return read;
}

function checkSshKey(key: string, problems: string[]): void {
  const trimmed = key?.trim() ?? '';
  if (trimmed === '') {
    problems.push(
      'A spawn carries the tenant’s SSH public key: no password is ever issued for a workload ' +
        '(spec §6.2), so without one there is no way in.'
    );
    return;
  }
  if (trimmed.startsWith('-----BEGIN')) {
    problems.push(
      'That is a PRIVATE key. The console wants the PUBLIC half — the one line in your ' +
        '`.pub` file. Nothing here ever needs your private key, and this one should now be ' +
        'treated as compromised.'
    );
    return;
  }
  if (!SSH_PUBLIC_KEY.test(trimmed)) {
    problems.push(
      'That does not look like an OpenSSH public key: one line of `<type> <base64> [comment]`, ' +
        'as `~/.ssh/id_ed25519.pub` holds it.'
    );
  }
}

/** The provider's answer to a spawn (§6.2), read defensively. */
export function readSpawnAnswer(body: unknown): {
  workloadId?: string;
  role?: string;
  expiresAt?: number;
  access?: LeaseAccess;
  error?: string;
  message?: string;
} {
  if (typeof body !== 'object' || body === null) return {};
  const answer = body as Record<string, unknown>;
  const access = answer.access;
  return {
    ...(typeof answer.workload_id === 'string' ? { workloadId: answer.workload_id } : {}),
    ...(typeof answer.role === 'string' ? { role: answer.role } : {}),
    ...(Number.isInteger(answer.expires_at) ? { expiresAt: answer.expires_at as number } : {}),
    ...(typeof access === 'object' && access !== null
      ? { access: access as LeaseAccess }
      : {}),
    ...(typeof answer.error === 'string' ? { error: answer.error } : {}),
    ...(typeof answer.message === 'string' ? { message: answer.message } : {}),
  };
}

/**
 * Does a published route prefix carry this destination?
 *
 * ILP prefixes are dot-separated and a prefix matches a destination beneath
 * it. `g.toon.provider` carries `g.toon.provider.basic.v1.spawn`;
 * `g.toon.provider2` carries neither it nor anything else of the first
 * provider's, which is why this compares SEGMENTS and not characters.
 */
export function routeCarries(prefix: string, destination: string): boolean {
  return destination === prefix || destination.startsWith(`${prefix}.`);
}

/** A `.anyone` connector: reachable only through a SOCKS proxy (spec §10). */
export function isHiddenServiceUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.anyone');
  } catch {
    return false;
  }
}

/** `https://node.example` and `https://node.example/ilp` are the same node. */
function sameConnector(a: string, b: string): boolean {
  const base = (url: string) => url.replace(/\/+$/u, '').replace(/\/ilp$/u, '');
  return base(a) === base(b);
}

function describeRefusal(outcome: Extract<PacketOutcome, { kind: 'refused' }>): string {
  const who =
    outcome.refusedBy === 'destination'
      ? 'The provider’s own connector refused this packet'
      : outcome.refusedBy === 'edge'
        ? 'The connector this console pays at refused this packet before routing it'
        : 'A hop on the way refused this packet';
  return `${who} (${outcome.code}): ${outcome.message}`;
}
