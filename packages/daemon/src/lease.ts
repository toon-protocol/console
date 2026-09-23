import type { ChannelStore } from '@toon-protocol/client';

import { channelStoreFor, findChannelBinding } from './channel-store.js';
import type { ChainSeedStore, PayerKeys } from './chain-seed.js';
import type { ConnectorHealth } from './connector-health.js';
import { continuationFor, mintRequestId, mintRootSecret } from './continuation.js';
import type { DirectoryResult, ListingView, ProviderView } from './directory.js';
import { resolveRpc } from './funding.js';
import {
  HiddenTransportError,
  isHiddenServiceUrl,
  proxyRpcFor,
  type HiddenTransportPort,
} from './hidden-transport.js';
import {
  LeaseVaultError,
  type LeaseAccess,
  type LeaseVault,
  type LeaseView,
  type MemberState,
  type VaultedLease,
  type VaultedMember,
} from './lease-vault.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import type { RelayWriteTargets } from './relay-write.js';
import { checkStandbySet } from './standby-set.js';
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
  /**
   * The `socks5h://` proxy this packet rides, when `payAt` is a `.anyone`
   * address (spec §10). Absent for every clearnet connector, and the client
   * refuses it there as pointless misdirection.
   */
  readonly socksProxy?: string | undefined;
  /** Whether the chain RPC rides the same circuit. See `hidden-transport.ts`. */
  readonly proxyRpc?: boolean | undefined;
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
        /**
         * This packet rides an Anyone Protocol circuit, because the connector
         * it is paid at is a `.anyone` address (§10). The proxy's own port is
         * NOT repeated here: it is this machine's business, and the health
         * view is where it is named once.
         */
        readonly overAnon?: boolean | undefined;
        /** Whether the chain RPC rides the same circuit (ADR 0008's third leg). */
        readonly rpcOverAnon?: boolean | undefined;
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

/* -------------------------------------------------------------------------- */
/* A Standby Set (spec §7, TOON_Network#95)                                   */
/* -------------------------------------------------------------------------- */

/**
 * One Warm Standby, and the tier its reservation is bought on.
 *
 * A member names its OWN Listing, because a Standby Set is several providers
 * and nothing makes two of them publish the same tier at the same version or
 * the same price. What they must share is the workload id and the membership
 * list; everything about how each one is bought is its own (§7).
 */
export interface StandbyMemberRequest {
  readonly provider: string;
  /** The Listing's `d` name, or its `30432:<pubkey>:<name>` address. */
  readonly listing: string;
  readonly listingVersion?: number | undefined;
  readonly chain?: string | undefined;
}

/**
 * A spawn that buys a primary lease AND its Warm Standbys, under one workload
 * id.
 *
 * `provider` and `listing` are the PRIMARY's — `standby_set[0]`, bought on
 * `.spawn` at the listing's price — and `standbys` are the rest of the set in
 * the order they would take the workload over, each bought on `.standby` at
 * its own tier's `standby_price` (§5, §7).
 */
export interface StandbySetSpawnRequest extends SpawnRequest {
  readonly standbys: readonly StandbyMemberRequest[];
}

export interface MemberPlanView {
  readonly pubkey: string;
  readonly index: number;
  readonly role: 'primary' | 'standby';
  /** Exactly what a single spawn's preflight says, for this member alone. */
  readonly view: PreflightView;
}

export interface StandbySetPreflightView {
  readonly ok: boolean;
  /** Wrong with the SET rather than with a member: §6.2 step 3's rules. */
  readonly problems: readonly string[];
  /** The one id every member's spawn will carry (§7). */
  readonly workloadId?: string | undefined;
  readonly members: readonly MemberPlanView[];
  /** What the whole set costs to spawn, base units, when every member quoted. */
  readonly cost?: string | undefined;
  readonly vault: PreflightView['vault'];
}

export interface MemberSpawnResult {
  readonly pubkey: string;
  readonly index: number;
  readonly role: 'primary' | 'standby';
  readonly route?: string | undefined;
  /** `false` when nothing left this console for this member. */
  readonly sent: boolean;
  readonly ok: boolean;
  /** What this member's spawn cost. Present on a refusal too (ADR 0003). */
  readonly cost?: string | undefined;
  readonly expiresAt?: number | undefined;
  /** Absent for a standby until a Takeover — nothing runs for a reservation. */
  readonly access?: LeaseAccess | undefined;
  readonly providerError?: string | undefined;
  readonly message?: string | undefined;
}

export interface StandbySetResult {
  readonly lease?: LeaseView | undefined;
  readonly preflight: StandbySetPreflightView;
  /** One per member, in `standby_set` order. A refusal is reported, not thrown. */
  readonly members: readonly MemberSpawnResult[];
  /** What the whole set cost, base units, when every member reported. */
  readonly cost?: string | undefined;
  readonly confirmationFailed?: string | undefined;
}

export interface LeaseStoreDeps {
  readonly profile: () => NetworkProfile;
  readonly vault: LeaseVault;
  readonly chainSeed: ChainSeedStore;
  readonly readHealth: (profile: NetworkProfile) => Promise<ConnectorHealth>;
  readonly readDirectory: (profile: NetworkProfile) => Promise<DirectoryResult>;
  readonly provider: ProviderPort;
  /**
   * The Anyone Protocol carriage, for a Hidden Provider (#98, spec §10).
   *
   * Absent means this build can reach no `.anyone` address at all, and a spawn
   * on a Hidden Provider then says so — it never becomes a direct dial.
   */
  readonly hidden?: HiddenTransportPort | undefined;
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
  /**
   * Which of §5's two spawn routes this member's request is paid on.
   *
   * `spawn` for a standalone lease and for index 0 of a Standby Set; `standby`
   * for every other index. It is not a preference: §6.2 step 3 refuses a
   * primary's spawn that arrives on `.standby` and a standby's that arrives on
   * `.spawn`, as `invalid_request`, after billing.
   */
  readonly route?: 'spawn' | 'standby' | undefined;
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
  /* A Standby Set                                                            */
  /* ------------------------------------------------------------------------ */

  /**
   * Everything a Standby Set's spawn would do, with nothing spent (§7).
   *
   * A set costs an interval at every member, so the case for a free preflight
   * is N times the case for a single spawn's: a `standby_set` that names a
   * provider twice, or a member whose tier prices no Warm Standby, is
   * `invalid_request` or `wrong_listing_version` at EVERY member it was sent
   * to — each refusal billed at that member's own price (ADR 0003,
   * TOON_Network#115).
   */
  async preflightSet(request: StandbySetSpawnRequest): Promise<StandbySetPreflightView> {
    return (await this.#planSet(request)).view;
  }

  /**
   * Buy a primary lease and its Warm Standbys under one workload id (§7).
   *
   * The order is the whole of the method, and each step is there because of
   * what the previous one costs.
   *
   * 1. **Plan every member, send nothing.** A set whose third member is
   *    mis-addressed must not have bought the first two.
   * 2. **Vault the Root Secret first**, naming the whole set (ADR 0021,
   *    §6.1.1). One record, one secret, one paid write — a token per member is
   *    DERIVED from it and never stored.
   * 3. **The primary's `.spawn` at `price`.** If it is definitively refused,
   *    nothing else is sent and the record is taken back: reservations for a
   *    workload that never started protect nothing and cost `standby_price`
   *    each.
   * 4. **Each standby's `.standby` at `standby_price`**, in its own request,
   *    naming only that member and presenting only that member's Continuation
   *    Token (§7). A standby that refuses does NOT stop the others and does
   *    NOT take the record back: the primary's lease is real, the remaining
   *    standbys are real, and the account paid for the refusal.
   * 5. **One confirmation write** for the whole set.
   *
   * @throws {LeaseError} before anything is paid, or when the PRIMARY's spawn
   *   failed — in which case the set does not exist.
   */
  async spawnSet(request: StandbySetSpawnRequest): Promise<StandbySetResult> {
    const planned = await this.#planSet(request);
    const { view } = planned;
    if (!view.ok || planned.members.length === 0) {
      const problems = [
        ...view.problems,
        ...view.members.flatMap((member) =>
          member.view.problems.map(
            (problem) => `${member.pubkey.slice(0, 12)}… (${member.role}): ${problem}`
          )
        ),
      ];
      throw new LeaseError(
        problems.some((problem) => problem.includes('No payment channel'))
          ? 'no_channel'
          : 'invalid_request',
        `This Standby Set was not spawned, and nothing was paid. ${problems.join(' ')}`,
        problems.some((problem) => problem.includes('No payment channel')) ? 409 : 400
      );
    }

    const localOnly = request.localOnly === true;
    const first = planned.members[0];
    if (first === undefined) throw new LeaseError('invalid_request', 'No members.');
    const rootSecret = mintRootSecret();
    const record: VaultedLease = {
      v: 1,
      state: 'spawning',
      workload_id: first.ready.content.workload_id,
      root_secret: rootSecret,
      standby_set: planned.members.map((member) => member.pubkey),
      members: planned.members.map((member) => memberRecord(member, 'spawning')),
      provider: providerRecord(first.ready),
      paid_at: first.ready.payAt,
      ...(first.ready.chain === undefined ? {} : { paid_chain: first.ready.chain }),
      listing: listingRecord(first.ready),
      profile_id: this.#deps.profile().id,
      image: first.ready.content.image,
      ports: first.ready.content.ports,
      env_keys: Object.keys(first.ready.content.env),
      created_at: this.#at().toISOString(),
      ...(first.ready.content.template === undefined
        ? {}
        : { template: first.ready.content.template }),
      ...(localOnly ? { local_only: true } : {}),
    };

    await this.#deps.vault.publish(record).catch((error: unknown) => {
      if (error instanceof LeaseVaultError) {
        throw new LeaseError(error.code, error.message, error.status, {
          ...(error.relays ? { relays: error.relays } : {}),
        });
      }
      throw error;
    });

    const workloadId = record.workload_id;
    const results: MemberSpawnResult[] = [];
    const confirmations: Parameters<LeaseVault['confirmSet']>[1][number][] = [];

    for (const member of planned.members) {
      const { ready } = member;
      const body = {
        request: {
          request_id: mintRequestId(),
          op: member.index === 0 ? ('spawn' as const) : ('standby' as const),
          provider: member.pubkey,
          expiration: this.#seconds() + REQUEST_TTL_S,
          // Derived per provider from the ONE Root Secret (§6.1.1), so every
          // member holds a different token and none can act as the tenant
          // against another.
          continuation: continuationFor(rootSecret, member.pubkey),
          content: ready.content,
        },
      };

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
        if (member.index === 0) {
          await this.#deps.vault.retract(
            workloadId,
            'the primary’s spawn was never sent: the payer keys could not be borrowed'
          );
          throw error;
        }
        results.push({
          pubkey: member.pubkey,
          index: member.index,
          role: member.role,
          route: ready.route,
          sent: false,
          ok: false,
          message: `This reservation was never sent: ${messageOf(error)}`,
        });
        confirmations.push({
          pubkey: member.pubkey,
          state: 'failed',
          failed_because: `the reservation was never sent: ${messageOf(error)}`,
        });
        continue;
      }

      const read = readMemberOutcome(outcome, workloadId);
      results.push({
        pubkey: member.pubkey,
        index: member.index,
        role: member.role,
        route: ready.route,
        sent: true,
        ok: read.ok,
        ...(read.cost === undefined ? {} : { cost: read.cost }),
        ...(read.expiresAt === undefined ? {} : { expiresAt: read.expiresAt }),
        ...(read.access === undefined ? {} : { access: read.access }),
        ...(read.error === undefined ? {} : { providerError: read.error }),
        ...(read.message === undefined ? {} : { message: read.message }),
      });

      if (member.index === 0 && !read.ok) {
        if (read.definitive) {
          // The primary did not start, so no reservation is worth buying: a
          // Warm Standby takes over a workload, and there is none.
          const taken = await this.#deps.vault.retract(
            workloadId,
            `the primary’s spawn was refused: ${read.error ?? 'no answer this console reads'}`
          );
          throw new LeaseError(
            'spawn_refused',
            `The primary of this Standby Set refused the spawn: ${read.error ?? 'unreadable answer'}. ` +
              `${read.message ?? ''} No reservation was bought — a Warm Standby holds capacity ` +
              `for a workload, and there is none. The lease record was taken back.` +
              (taken.retracted
                ? ''
                : ` The record could NOT be taken back: ${taken.reason ?? ''}`) +
              (read.cost === undefined
                ? ''
                : ` It was still billed ${read.cost} base units — a paid route bills for an ` +
                  `answer, and a refusal is one (ADR 0003, spec §5).`),
            502,
            read.error === undefined ? {} : { providerError: read.error }
          );
        }
        // NOT retracted, and no standby bought: a packet nobody reported on
        // may have started a workload, and its Root Secret is the only thing
        // that could ever stop it.
        throw new LeaseError(
          'spawn_unconfirmed',
          `The primary's spawn was sent and nothing came back: ${read.message ?? ''} The lease ` +
            `record is kept, because a workload may be running behind it and its Root Secret is ` +
            `the only thing that could stop it. No reservation was bought. Ask the primary for ` +
            `its status — that is free — before spawning again.`,
          504
        );
      }

      confirmations.push({
        pubkey: member.pubkey,
        state: read.ok ? ('live' as MemberState) : ('failed' as MemberState),
        ...(read.role === undefined ? {} : { role: read.role }),
        ...(read.expiresAt === undefined ? {} : { expires_at: read.expiresAt }),
        ...(read.access === undefined ? {} : { access: read.access }),
        ...(read.ok
          ? {}
          : {
              failed_because:
                read.error ?? 'the provider’s answer was not one this console reads',
            }),
      });
    }

    const confirmed = await this.#deps.vault.confirmSet(workloadId, confirmations);
    const lease = this.#deps.vault.find(workloadId);
    return {
      ...(lease === undefined ? {} : { lease }),
      preflight: view,
      members: results,
      ...optionalCost(results.map((member) => member.cost)),
      ...(confirmed.confirmed ? {} : { confirmationFailed: confirmed.reason ?? 'unknown' }),
    };
  }

  /** Every member's plan, and the set's own problems. Sends nothing. */
  async #planSet(request: StandbySetSpawnRequest): Promise<{
    view: StandbySetPreflightView;
    members: readonly (MemberPlanView & { ready: ReadyPlan })[];
  }> {
    const setProblems: string[] = [];
    const seats: readonly StandbyMemberRequest[] = [
      { provider: request.provider, listing: request.listing, chain: request.chain },
      ...request.standbys,
    ];
    const pubkeys = seats.map((seat) => seat.provider);
    setProblems.push(...checkStandbySet(pubkeys));

    const targets = await this.#deps.vault.targets();
    const vault = { localOnly: request.localOnly === true, writes: targets };

    const views: MemberPlanView[] = [];
    const ready: (MemberPlanView & { ready: ReadyPlan })[] = [];
    for (const [index, seat] of seats.entries()) {
      const problems: string[] = [];
      // ONE content, built once and checked against each member's own Listing
      // — because §7 sends the same content to every member, and a volume that
      // fits one provider's tier need not fit another's.
      const content = manualContent(
        { ...request, workloadId: request.workloadId ?? undefined },
        problems
      );
      const withSet =
        content === undefined
          ? undefined
          : ({ ...content, standby_set: pubkeys } as SpawnContent);
      const plan = await this.#plan(
        {
          provider: seat.provider,
          listing: seat.listing,
          localOnly: request.localOnly === true,
          route: index === 0 ? 'spawn' : 'standby',
          ...(seat.chain === undefined ? {} : { chain: seat.chain }),
          ...(seat.listingVersion === undefined
            ? {}
            : { listingVersion: seat.listingVersion }),
        },
        withSet,
        problems
      );
      const role = index === 0 ? ('primary' as const) : ('standby' as const);
      const entry: MemberPlanView = {
        pubkey: seat.provider,
        index,
        role,
        view: plan.view,
      };
      views.push(entry);
      if (plan.ready !== undefined && plan.view.ok) {
        ready.push({ ...entry, ready: plan.ready });
      }
    }

    // ONE workload id for the whole set (§7), and it is the FIRST member's:
    // every member's content is built from the same request, so they agree
    // unless the caller fixed one — in which case they agree on that.
    const workloadId = ready[0]?.ready.content.workload_id;
    const spread = ready.map((member) => ({
      ...member,
      ready: {
        ...member.ready,
        content: { ...member.ready.content, workload_id: workloadId } as SpawnContent,
      },
    }));

    const ok =
      setProblems.length === 0 &&
      views.length === seats.length &&
      views.every((member) => member.view.ok) &&
      spread.length === seats.length;

    return {
      view: {
        ok,
        problems: setProblems,
        ...(workloadId === undefined ? {} : { workloadId }),
        members: views,
        ...optionalCost(views.map((member) => member.view.payment?.routePrice)),
        vault,
      },
      members: ok ? spread : [],
    };
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
    const set = ready.content.standby_set ?? [ready.provider.pubkey];
    if (set.length > 1) {
      // §7: every member of a Standby Set needs its own request, on its own
      // route, with its own Continuation Token. This path buys ONE. Selling a
      // person a primary lease and calling it a Standby Set would leave them
      // paying for a set that protects nothing, so the answer is no — before
      // anything is paid.
      throw new LeaseError(
        'standby_set_unbought',
        `This spawn names a Standby Set of ${set.length} members but buys one lease. Every ` +
          `member is spawned in a request of its own — the primary on \`.spawn\` at the ` +
          `listing's price, each Warm Standby on \`.standby\` at its \`standby_price\` (§7) — ` +
          `so spawn the set as a set. Nothing was sent and nothing was paid.`
      );
    }
    const rootSecret = mintRootSecret();
    const record: VaultedLease = {
      v: 1,
      state: 'spawning',
      workload_id: ready.content.workload_id,
      root_secret: rootSecret,
      standby_set: set,
      members: [
        {
          pubkey: ready.provider.pubkey,
          index: 0,
          ilp_address: ready.provider.profile.ilpAddress,
          connector_url: ready.provider.profile.connectorUrl,
          connector_seal_key: ready.provider.profile.connectorSealKey,
          ...(ready.provider.profile.hidden ? { hidden: true } : {}),
          listing: listingRecord(ready),
          paid_at: ready.payAt,
          ...(ready.chain === undefined ? {} : { paid_chain: ready.chain }),
          state: 'spawning',
        },
      ],
      provider: providerRecord(ready),
      paid_at: ready.payAt,
      ...(ready.chain === undefined ? {} : { paid_chain: ready.chain }),
      listing: listingRecord(ready),
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
          ...(ready.socksProxy === undefined ? {} : { socksProxy: ready.socksProxy }),
          ...(ready.proxyRpc === undefined ? {} : { proxyRpc: ready.proxyRpc }),
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

    // §6.2 step 2: a `.standby` route exists for exactly the listings whose
    // Listing event carries `standby_price` (§4.2, §5). A tier that prices no
    // Warm Standby sells none, and a connector MUST NOT terminate a route the
    // provider did not price — so a `.standby` spawn on one is refused
    // `wrong_listing_version`, and billed. Caught here, where it is free.
    const op = selection.route ?? 'spawn';
    if (op === 'standby' && listing.standbyPrice === undefined) {
      problems.push(
        `${JSON.stringify(listing.name)} v${listing.version} prices no Warm Standby, so this ` +
          `provider sells none on it and its connector terminates no \`.standby\` route at ` +
          `all (§4.2, §5). A reservation bought there is refused \`wrong_listing_version\` — ` +
          `and billed. Choose a tier this provider publishes a \`standby_price\` for.`
      );
      return unready();
    }

    const route = `${provider.profile.ilpAddress}.${listing.name}.v${listing.version}.${op}`;
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
        ...(payment.view.chain === undefined ? {} : { chain: payment.view.chain }),
        sealTo: provider.profile.connectorSealKey,
        chainKind: payment.chainKind,
        rpcUrl: payment.rpcUrl,
        channelStore: payment.channelStore,
        ...(payment.socksProxy === undefined ? {} : { socksProxy: payment.socksProxy }),
        ...(payment.proxyRpc === undefined ? {} : { proxyRpc: payment.proxyRpc }),
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
    // A `.anyone` connector is a Hidden Provider's (spec §10, ADR 0008), and
    // it is reached over a circuit or not at all. The carriage is resolved
    // HERE, before anything is read or paid, so that "no circuit" is a problem
    // on a preflight rather than a packet that cannot leave — and so that the
    // one thing it must never become, a direct dial at whatever host leaked,
    // has nowhere to happen. `hidden-transport.ts` says why there is no
    // fallback.
    let anon: { socksProxy: string } | undefined;
    if (isHiddenServiceUrl(payAt)) {
      const carriage = this.#deps.hidden;
      if (carriage === undefined) {
        problems.push(
          `The connector at ${payAt} is a Hidden Provider's, reachable only over an Anyone ` +
            `Protocol circuit, and this build has no carriage for one (spec §10).`
        );
        return undefined;
      }
      try {
        anon = { socksProxy: (await carriage.open()).socksProxy };
      } catch (error) {
        problems.push(
          error instanceof HiddenTransportError
            ? error.message
            : `The Anyone Protocol carriage could not be opened: ${
                error instanceof Error ? error.message : String(error)
              }`
        );
        return undefined;
      }
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
    for (const settlement of settlements) {
      const binding = findChannelBinding(channels.store, payAt, settlement.chain);
      if (!binding) continue;
      const rpc = resolveRpc(profile, settlement.kind);
      // The chain the channel lives on rides the same circuit unless it is
      // already private, where `anon` would build no circuit at all.
      const proxyRpc = anon === undefined ? undefined : await proxyRpcFor(rpc.url);
      return {
        payAt,
        chainKind: settlement.kind,
        rpcUrl: rpc.url,
        channelStore: channels.store,
        ...(anon === undefined ? {} : { socksProxy: anon.socksProxy, proxyRpc }),
        view: {
          connectorUrl: payAt,
          via,
          reason,
          chain: settlement.chain,
          channelId: binding.channelId,
          ...(routePrice === undefined ? {} : { routePrice }),
          ...(anon === undefined ? {} : { overAnon: true, rpcOverAnon: proxyRpc }),
        },
      };
    }

    problems.push(
      `No payment channel with the connector at ${payAt}. A spawn pays from a channel and must ` +
        `never open one for you — opening locks collateral on chain and costs the chain's own ` +
        `gas. Open one on ${settlements.map((entry) => entry.chain).join(' or ')} from ` +
        `the Funds tab, naming this connector.`
    );
    const fallbackRpc = resolveRpc(profile, settlements[0]?.kind ?? 'evm').url;
    const fallbackProxyRpc = anon === undefined ? undefined : await proxyRpcFor(fallbackRpc);
    return {
      payAt,
      chainKind: settlements[0]?.kind ?? 'evm',
      rpcUrl: fallbackRpc,
      channelStore: channels.store,
      ...(anon === undefined
        ? {}
        : { socksProxy: anon.socksProxy, proxyRpc: fallbackProxyRpc }),
      view: {
        connectorUrl: payAt,
        via,
        reason,
        ...(routePrice === undefined ? {} : { routePrice }),
        ...(anon === undefined ? {} : { overAnon: true, rpcOverAnon: fallbackProxyRpc }),
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
  readonly socksProxy?: string | undefined;
  readonly proxyRpc?: boolean | undefined;
  readonly view: NonNullable<PreflightView['payment']>;
}

interface ReadyPlan {
  readonly provider: ProviderView;
  readonly listing: ListingView;
  readonly route: string;
  readonly content: SpawnContent;
  readonly payAt: string;
  /** The settlement chain this spawn pays on. An extension must use the same. */
  readonly chain?: string | undefined;
  readonly sealTo: string;
  readonly chainKind: 'evm' | 'solana';
  readonly rpcUrl: string;
  readonly channelStore: ChannelStore;
  /** Set only when this packet rides a circuit to a `.anyone` connector (§10). */
  readonly socksProxy?: string | undefined;
  readonly proxyRpc?: boolean | undefined;
}

interface Plan {
  readonly view: PreflightView;
  readonly ready?: ReadyPlan | undefined;
}

function providerRecord(ready: ReadyPlan): VaultedLease['provider'] {
  return {
    pubkey: ready.provider.pubkey,
    ilp_address: ready.provider.profile.ilpAddress,
    connector_url: ready.provider.profile.connectorUrl,
    connector_seal_key: ready.provider.profile.connectorSealKey,
    ...(ready.provider.profile.hidden ? { hidden: true } : {}),
  };
}

function listingRecord(ready: ReadyPlan): VaultedLease['listing'] {
  return {
    name: ready.listing.name,
    version: ready.listing.version,
    address: ready.listing.address,
    lease_interval_s: ready.listing.leaseIntervalSeconds,
    price: ready.listing.price,
  };
}

function memberRecord(
  member: MemberPlanView & { ready: ReadyPlan },
  state: MemberState
): VaultedMember {
  const { ready } = member;
  return {
    pubkey: member.pubkey,
    index: member.index,
    ilp_address: ready.provider.profile.ilpAddress,
    connector_url: ready.provider.profile.connectorUrl,
    connector_seal_key: ready.provider.profile.connectorSealKey,
    ...(ready.provider.profile.hidden ? { hidden: true } : {}),
    listing: listingRecord(ready),
    paid_at: ready.payAt,
    ...(ready.chain === undefined ? {} : { paid_chain: ready.chain }),
    state,
  };
}

/**
 * One member's spawn outcome, in the two halves a caller has to tell apart.
 *
 * `definitive` is the whole point. A provider that answered — with a lease or
 * with a refusal — has DECIDED, so a lease that did not start definitely did
 * not start and the record may be taken back. A packet nobody reported on has
 * decided nothing, and a Root Secret dropped behind one is a workload nobody
 * can ever stop.
 */
function readMemberOutcome(
  outcome: PacketOutcome,
  workloadId: string
): {
  ok: boolean;
  definitive: boolean;
  cost?: string;
  role?: string;
  expiresAt?: number;
  access?: LeaseAccess;
  error?: string;
  message?: string;
} {
  if (outcome.kind === 'unknown') {
    return { ok: false, definitive: false, message: outcome.message };
  }
  if (outcome.kind === 'refused') {
    return {
      ok: false,
      definitive: true,
      ...(outcome.cost === undefined ? {} : { cost: outcome.cost }),
      error: outcome.code,
      message: describeRefusal(outcome),
    };
  }
  const answered = readSpawnAnswer(outcome.body);
  const cost = outcome.cost === undefined ? {} : { cost: outcome.cost };
  if (answered.error !== undefined || outcome.status !== 200) {
    return {
      ok: false,
      definitive: true,
      ...cost,
      error: answered.error ?? `HTTP ${outcome.status}`,
      ...(answered.message === undefined ? {} : { message: answered.message }),
    };
  }
  if (answered.workloadId !== workloadId) {
    return {
      ok: false,
      // NOT definitive: this member answered about a lease this console did
      // not buy, and something may be running behind it. Its Root Secret must
      // survive whatever else happens to the set.
      definitive: false,
      ...cost,
      error: 'wrong_workload',
      message:
        `This member answered about workload ${answered.workloadId ?? 'nothing'}, not the one ` +
        `this set asked for.`,
    };
  }
  return {
    ok: true,
    definitive: true,
    ...cost,
    ...(answered.role === undefined ? {} : { role: answered.role }),
    ...(answered.expiresAt === undefined ? {} : { expiresAt: answered.expiresAt }),
    ...(answered.access === undefined ? {} : { access: answered.access }),
  };
}

/** The sum, when every part reported one. A missing part means no total. */
function optionalCost(
  parts: readonly (string | undefined)[]
): { cost: string } | Record<string, never> {
  let sum = 0n;
  for (const part of parts) {
    if (part === undefined) return {};
    try {
      sum += BigInt(part);
    } catch {
      return {};
    }
  }
  return parts.length === 0 ? {} : { cost: sum.toString() };
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
    // own token (§7). The rules a set must satisfy live in `standby-set.ts`;
    // whether this console is about to buy every member of it is `#buy`'s
    // business, because a half-formed Standby Set protects nothing while
    // costing an interval at every member it did reach.
    problems.push(...checkStandbySet(content.standby_set));
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
