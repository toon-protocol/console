import { channelAvailable, channelStoreFor, findChannelBinding } from './channel-store.js';
import type { ChainSeedStore } from './chain-seed.js';
import type { ConnectorHealth } from './connector-health.js';
import { gatewaySub } from './continuation.js';
import { resolveRpc } from './funding.js';
import { hostnameFor, probeUrlFor, sameHostname } from './gateway-name.js';
import {
  HiddenTransportError,
  isHiddenServiceUrl,
  proxyRpcFor,
  type HiddenTransportPort,
} from './hidden-transport.js';
import { routeCarries, type PacketOutcome, type ProviderPort } from './lease.js';
import { LeaseVaultError, type LeaseVault, type LeaseView } from './lease-vault.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import { HEX_32 } from './spawn-content.js';
import type { WorkloadNoteStore } from './workload-cache.js';
import type { OpRouteView } from './workload.js';

/**
 * **The hostname**: handing a workload to a Workload Gateway, and taking it
 * back (TOON_Network#97, spec §12, ADR 0013, ADR 0017, ADR 0018, ADR 0023).
 *
 * A lease gives a person a container on one provider's address. This is the
 * module that turns it into a name. It sends exactly two messages, both sealed
 * to the gateway's own connector, both on the one route that connector
 * terminates, and the body's single key says which of the two it is (§12.7).
 *
 * Six facts shape every line of it.
 *
 * **A grant is derived, never issued, and never stored.** §6.5.1's
 * `gateway_sub(provider, expires_at)` is HKDF over the lease's Continuation
 * Token, which is itself HKDF over the Root Secret. The console holds the root
 * secret in the Lease Vault and nowhere else, so every grant is derived inside
 * `vault.withContinuation` for the length of one message and is gone
 * afterwards. Nothing on disk, in an answer or in a log line has ever held
 * one, and the note this module keeps is deliberately shaped so that it could
 * not: it records the *moment* a grant was derived for, which is enough to
 * derive the same value again and is not itself a secret.
 *
 * **One grant per member of the Standby Set.** `gateway_sub` derives from
 * `continuation(provider)`, which derives under that member's own key — so a
 * grant derived for the primary is `bad_grant` at a standby, and a gateway
 * resolving a workload asks all of them at once (§12.4). The set is the
 * lease's own, primary first, taken from the vault record. That is the seam
 * with warm standbys (TOON_Network#95): whatever a Standby Set grows to, this
 * derives a grant for each member of it with nothing here to change.
 *
 * **A handover is admitted or dropped, and nothing in between.** The gateway
 * makes one immediate round of `status` to the members named and refuses
 * `not_admitted` when none of them accepts (§12.1, since TOON_Network#114 it
 * no longer takes a grant it cannot prove). So a refusal here is a fact about
 * the *lease* — a rotated token, a member that never held it, a provider
 * nobody can reach — and the message says so rather than offering a retry that
 * would be refused identically.
 *
 * **The hostname is derived here too, and compared.** §12.2 makes it a pure
 * function of the workload id, so this console computes it, shows it before
 * anything is sent, and then checks the gateway's answer against it. "The
 * hostname shown matches what the gateway serves" is a comparison of two
 * independently produced values plus a knock on the door, never a copy of what
 * the gateway said.
 *
 * **A withdrawal ends serving, not reading** (§12.7, ADR 0018). The withdrawn
 * gateway keeps a working grant until the moment it was derived for. This
 * module says that in the answer rather than letting a person believe they
 * revoked something, and names the one thing that does revoke: rotating the
 * lease's Continuation Token (TOON_Network#96), after which every grant of the
 * old token is `bad_grant` at once — and a fresh handover derives from the new
 * one with nothing here to change, because the derivation reads whatever the
 * vault currently holds.
 *
 * **Both messages are free, and bought where they are free.** The gateway
 * prices its handover route at zero, so the packet is paid at the gateway's
 * own connector — which terminates it — rather than through a hop that would
 * charge its own fee to forward. That is #93's rule, applied to a second kind
 * of route, and when no zero-priced path exists the price is named rather than
 * quietly paid.
 */

/* -------------------------------------------------------------------------- */
/* What is remembered between handovers                                       */
/* -------------------------------------------------------------------------- */

/**
 * What this console handed over, kept so a withdrawal knows which grant to
 * bear and a card knows what it is showing.
 *
 * **Read the fields for what is NOT here.** No grant, no Continuation Token,
 * no Root Secret. A withdrawal must bear the grant in force (§12.7), and it
 * gets one by deriving it again from `expiresAt` and `standbySet` — the two
 * inputs that, with the vault's secret, reproduce it byte for byte. Keeping
 * the derived value instead would put a secret in a file whose only job is to
 * make a card render.
 */
export interface GatewayNote {
  /** The canonical hostname, as §12.2 derives it. */
  readonly hostname: string;
  /** The moment the grants were derived for, and the moment serving stops. */
  readonly expiresAt: number;
  /** Which container port the gateway forwards to (§12.4 step 5). */
  readonly httpPort: number;
  /** The readable label asked for, when one was. The gateway may ignore it. */
  readonly name?: string | undefined;
  /** The Standby Set the handover named, primary first. */
  readonly standbySet: readonly string[];
  /** Which gateway. A handover names none: being sealed to it is what does. */
  readonly connectorUrl: string;
  readonly route: string;
  /** When this console handed it over. */
  readonly at: string;
  /** Set once withdrawn, so a card can say so rather than just forgetting. */
  readonly withdrawnAt?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* Knocking on the door                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the hostname itself answered.
 *
 * The one check in this module that goes nowhere near the protocol: an
 * ordinary HTTPS request to the name, from this machine, exactly as a person's
 * browser would make it. It is here because every other signal is a report
 * from an interested party — the gateway saying it admitted a grant, a
 * provider saying a workload runs — and the question a person actually has is
 * whether the URL works.
 */
export interface ProbeAnswer {
  readonly status: number;
  /** The gateway's own §12.3 reason, from `toon-gateway-reason` or the body. */
  readonly reason?: string | undefined;
  /** A short prefix of the body, for a person to recognise their own app by. */
  readonly excerpt?: string | undefined;
}

export interface GatewayProbe {
  /** @throws when the name did not answer at all. The caller reports that. */
  knock(url: string, options?: { timeoutMs?: number }): Promise<ProbeAnswer>;
}

/**
 * What the hostname is doing, in the four kinds a person must tell apart.
 *
 * `no_grant` is not a fault: it is §12.3's healthy empty state, and it is what
 * a hostname answers before its first handover and after a withdrawal. It is
 * kept apart from `refused` — a gateway that holds a grant and cannot resolve
 * the workload — because the first means "nothing was handed over" and the
 * second means "something is wrong with the lease", and they are acted on
 * differently.
 */
export type ServingView =
  | {
      readonly kind: 'serving';
      readonly status: number;
      readonly excerpt?: string | undefined;
      readonly at: string;
    }
  | { readonly kind: 'no_grant'; readonly message: string; readonly at: string }
  | {
      readonly kind: 'refused';
      /** One of §12.3's reasons, verbatim. A reason this build does not know is kept. */
      readonly reason: string;
      readonly status: number;
      readonly message: string;
      readonly at: string;
    }
  | { readonly kind: 'unreachable'; readonly message: string; readonly at: string };

/* -------------------------------------------------------------------------- */
/* What a person sees                                                         */
/* -------------------------------------------------------------------------- */

/** The gateway this profile hands over to, as its own `GET /ilp` describes it. */
export interface GatewayEdgeView {
  readonly connectorUrl: string;
  readonly ilpAddress: string;
  readonly route: string;
  /** Base units per handover, verbatim from the connector that quoted it. */
  readonly price?: string | undefined;
  /** The suffix hostnames are served under, from the active profile. */
  readonly domain: string;
}

export interface GatewayView {
  readonly workloadId: string;
  /**
   * The hostname this workload would be — or is — served at.
   *
   * Derived from the workload id alone (§12.2), so it is known before anything
   * is handed over and does not depend on the gateway agreeing. Absent only
   * when the profile names no gateway domain.
   */
  readonly hostname?: string | undefined;
  readonly gateway?: GatewayEdgeView | undefined;
  /** What this console last handed over. Absent when it never has. */
  readonly handover?: GatewayNote | undefined;
  /** True while a handover this console made has not been withdrawn or expired. */
  readonly held: boolean;
  /** Set when the grant in force has run out: §12.3 answers `grant_expired`. */
  readonly expired?: boolean | undefined;
  /** Everything that would stop a handover, before one is sent. */
  readonly problems: readonly string[];
  readonly ok: boolean;
  /** The container ports the spawn asked for, to choose an HTTP one from. */
  readonly ports: readonly number[];
  /** Which one a handover would name if the caller named none. */
  readonly httpPort?: number | undefined;
  /** What the hostname answered, when it was asked. */
  readonly serving?: ServingView | undefined;
  readonly checkedAt: string;
}

/** What a person asks for when handing a workload over. */
export interface HandoverRequest {
  /** The moment the grants are derived for. Unix seconds. */
  readonly expiresAt?: number | undefined;
  /** Or: how long from now, in seconds. Exactly one of the two. */
  readonly expiresIn?: number | undefined;
  /** Which container port carries HTTP. The spawn's only port, when it has one. */
  readonly httpPort?: number | undefined;
  /** An optional readable label, served beside the canonical hostname (§12.6). */
  readonly name?: string | undefined;
  /** Which settlement chain to pay on, if the route is not free. */
  readonly chain?: string | undefined;
}

export interface HandoverResult {
  /** `false` when nothing was sent. Then `problems` says why. */
  readonly sent: boolean;
  readonly problems: readonly string[];
  readonly route?: OpRouteView | undefined;
  readonly cost?: string | undefined;
  /** The hostname the gateway answered with (§12.1). */
  readonly hostname?: string | undefined;
  /** The hostname this console derived, independently (§12.2). */
  readonly expectedHostname?: string | undefined;
  /** Whether the two agree. `false` is a gateway serving a name we do not know. */
  readonly matches?: boolean | undefined;
  readonly expiresAt?: number | undefined;
  /** The gateway's own refusal code, when it refused. */
  readonly gatewayError?: string | undefined;
  readonly message?: string | undefined;
  readonly view: GatewayView;
}

export interface WithdrawalResult {
  readonly sent: boolean;
  readonly problems: readonly string[];
  readonly route?: OpRouteView | undefined;
  readonly cost?: string | undefined;
  readonly hostname?: string | undefined;
  readonly withdrawn?: boolean | undefined;
  readonly gatewayError?: string | undefined;
  readonly message?: string | undefined;
  readonly view: GatewayView;
}

export class GatewayError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

export interface GatewayStoreDeps {
  readonly profile: () => NetworkProfile;
  readonly vault: LeaseVault;
  readonly chainSeed: ChainSeedStore;
  readonly readHealth: (profile: NetworkProfile) => Promise<ConnectorHealth>;
  /**
   * The sealed packet, behind the same port a Lease Request goes through.
   *
   * The same port because it is the same kind of thing: a body sealed to a
   * connector's pinned key, addressed to a route that connector terminates,
   * paid for where it is cheapest. A gateway is an ordinary TOON app (§12) and
   * nothing about reaching one needs a second transport.
   */
  readonly gateway: ProviderPort;
  /**
   * The Anyone Protocol carriage (TOON_Network#98, spec §10). A gateway whose
   * own connector is a `.anyone` address is reached over a circuit like any
   * other, and without one the handover says so rather than dialling.
   */
  readonly hidden?: HiddenTransportPort | undefined;
  readonly probe: GatewayProbe;
  readonly paths: ConsolePaths;
  readonly notes: WorkloadNoteStore;
  readonly now?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * How long a grant is derived for when the caller names no moment.
 *
 * A day. Short enough that a leaked grant reads a lease's `status` for a day
 * rather than forever, long enough that nobody has to think about it between
 * one sitting and the next. Renewing is an ordinary second handover on a free
 * route — the old grant keeps working until its own moment passes — so the
 * cost of choosing a short default is one free packet.
 */
export const DEFAULT_GRANT_SECONDS = 24 * 60 * 60;

/** §12.6: a readable name is one DNS label, and the gateway checks it too. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u;

export class GatewayStore {
  readonly #deps: GatewayStoreDeps;

  constructor(deps: GatewayStoreDeps) {
    this.#deps = deps;
  }

  /**
   * What this workload's hostname is, and what a handover would do.
   *
   * Free and sends nothing to anybody, unless `probe` is asked for — which
   * knocks on the hostname itself, over ordinary HTTPS, reaching no provider
   * and no connector.
   */
  async view(workloadId: string, options: { probe?: boolean } = {}): Promise<GatewayView> {
    const lease = this.#lease(workloadId);
    const view = await this.#view(lease);
    if (options.probe !== true || view.hostname === undefined) return view;
    return { ...view, serving: await this.#knock(view.hostname) };
  }

  /**
   * Hand this workload to the gateway: derive a grant per member, seal one
   * message, and show the hostname it came back with.
   *
   * @throws {GatewayError} when there is no such lease.
   */
  async handover(workloadId: string, request: HandoverRequest = {}): Promise<HandoverResult> {
    const lease = this.#lease(workloadId);
    const problems: string[] = [];
    const planned = await this.#plan(lease, problems, request.chain);
    const expiresAt = this.#expiry(request, problems);
    const httpPort = this.#httpPort(lease, request.httpPort, problems);
    const name = this.#name(request.name, problems);

    if (planned === undefined || problems.length > 0 || expiresAt === undefined) {
      return { sent: false, problems, ...route(planned), view: await this.#view(lease) };
    }

    let body: unknown;
    try {
      body = {
        handover: {
          workload_id: lease.workloadId,
          standby_set: await this.#grants(lease, expiresAt),
          http_port: httpPort,
          expires_at: expiresAt,
          ...(name === undefined ? {} : { name }),
        },
      };
    } catch (error) {
      return {
        sent: false,
        problems: [this.#whyNoGrant(error)],
        ...route(planned),
        view: await this.#view(lease),
      };
    }

    const outcome = await this.#send(planned, body);
    const cost = costOf(outcome);
    const expected = hostnameFor(lease.workloadId, this.#deps.profile().gatewayDomain);

    if (outcome.kind === 'unknown') {
      // The gateway may have admitted it. Nothing here guesses: the hostname
      // itself is the authority, and knocking on it is free.
      return {
        sent: true,
        problems: [],
        ...route(planned),
        ...optional('expectedHostname', expected),
        message:
          `The handover was sent and nothing came back: ${outcome.message} Whether the ` +
          `gateway admitted it is unknown. Ask the hostname — that costs nothing and it is ` +
          `the only answer that matters.`,
        view: await this.#view(
          lease,
          expected === undefined ? undefined : await this.#knock(expected)
        ),
      };
    }

    const read = readGatewayAnswer(outcome);
    if (read.error !== undefined) {
      return {
        sent: true,
        problems: [],
        ...route(planned),
        ...(cost === undefined ? {} : { cost }),
        ...optional('expectedHostname', expected),
        gatewayError: read.error,
        message: refusalWords(read.error, read.message),
        view: await this.#view(lease),
      };
    }

    // Admitted. What is remembered is what derives the same grants again, and
    // nothing that is itself a secret.
    const note: GatewayNote = {
      hostname: read.hostname ?? expected ?? '',
      expiresAt: read.expiresAt ?? expiresAt,
      httpPort,
      ...(name === undefined ? {} : { name }),
      standbySet: lease.standbySet,
      connectorUrl: planned.payAt,
      route: planned.route,
      at: this.#at().toISOString(),
    };
    this.#note(lease.workloadId, note);

    return {
      sent: true,
      problems: [],
      ...route(planned),
      ...(cost === undefined ? {} : { cost }),
      ...optional('hostname', read.hostname),
      ...optional('expectedHostname', expected),
      ...(read.hostname === undefined || expected === undefined
        ? {}
        : { matches: sameHostname(read.hostname, expected) }),
      expiresAt: read.expiresAt ?? expiresAt,
      view: await this.#view(lease),
    };
  }

  /**
   * Stop the gateway serving this workload.
   *
   * It bears the grant in force, re-derived from the moment the handover named
   * — which is the only thing that authorizes it, since nothing signs a
   * withdrawal (§12.7). It ends serving; it does not end reading.
   */
  async withdraw(workloadId: string): Promise<WithdrawalResult> {
    const lease = this.#lease(workloadId);
    const problems: string[] = [];
    const held = this.#noteFor(workloadId);
    if (held === undefined || held.withdrawnAt !== undefined) {
      problems.push(
        held === undefined
          ? `This console has not handed workload ${workloadId.slice(0, 12)}… to a gateway, so ` +
              `it knows of no grant to bear and cannot ask one to stop serving. A withdrawal must ` +
              `carry the grant in force (spec §12.7), and this console derives that from the ` +
              `moment a handover named — which it only knows for a handover it made.`
          : `This workload was already withdrawn at ${held.withdrawnAt}. The gateway answers its ` +
              `hostname \`no_grant\`, and there is nothing further to stop.`
      );
    }
    const planned = await this.#plan(lease, problems, undefined, held?.connectorUrl);
    if (planned === undefined || held === undefined || problems.length > 0) {
      return { sent: false, problems, ...route(planned), view: await this.#view(lease) };
    }

    let body: unknown;
    try {
      body = {
        withdrawal: {
          workload_id: lease.workloadId,
          expires_at: held.expiresAt,
          // The set the HANDOVER named, not the lease's set now: a withdrawal
          // must bear a grant this gateway holds, and a member added since
          // would derive one it never saw.
          standby_set: await this.#grants(lease, held.expiresAt, held.standbySet),
        },
      };
    } catch (error) {
      return {
        sent: false,
        problems: [this.#whyNoGrant(error)],
        ...route(planned),
        view: await this.#view(lease),
      };
    }

    const outcome = await this.#send(planned, body);
    const cost = costOf(outcome);

    if (outcome.kind === 'unknown') {
      return {
        sent: true,
        problems: [],
        ...route(planned),
        message:
          `The withdrawal was sent and nothing came back: ${outcome.message} Whether the ` +
          `gateway stopped serving is unknown — ask the hostname, which is free. A withdrawal ` +
          `is safe to send again: one that names a workload no longer served is \`not_withdrawn\`.`,
        view: await this.#view(lease, await this.#knock(held.hostname)),
      };
    }

    const read = readGatewayAnswer(outcome);
    if (read.error !== undefined) {
      return {
        sent: true,
        problems: [],
        ...route(planned),
        ...(cost === undefined ? {} : { cost }),
        gatewayError: read.error,
        message: refusalWords(read.error, read.message),
        view: await this.#view(lease),
      };
    }

    this.#note(lease.workloadId, { ...held, withdrawnAt: this.#at().toISOString() });
    return {
      sent: true,
      problems: [],
      ...route(planned),
      ...(cost === undefined ? {} : { cost }),
      ...optional('hostname', read.hostname ?? held.hostname),
      withdrawn: true,
      message:
        `${read.hostname ?? held.hostname} is no longer served here. The gateway KEEPS the ` +
        `grant it was handed until ${new Date(held.expiresAt * 1000).toISOString()}: a ` +
        `withdrawal ends serving, not reading (spec §12.7). Rotating this lease's ` +
        `Continuation Token is what ends the reading, and it ends every grant of the old ` +
        `token at once (spec §6.8, ADR 0018).`,
      view: await this.#view(lease),
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Deriving                                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * One Gateway Grant per member, primary first (§12.1).
   *
   * The Root Secret never leaves the vault: `withContinuation` opens the
   * record, derives that member's Continuation Token, hands it to this
   * function and drops it. What comes back out is the grant, which goes
   * straight into a body that is sealed — never into a note, an answer or a
   * log line.
   */
  async #grants(
    lease: LeaseView,
    expiresAt: number,
    members: readonly string[] = lease.standbySet
  ): Promise<{ provider: string; grant: string }[]> {
    const set: { provider: string; grant: string }[] = [];
    for (const member of members) {
      set.push(
        await this.#deps.vault.withContinuation(lease.workloadId, member, (continuation) =>
          Promise.resolve({ provider: member, grant: gatewaySub(continuation, expiresAt) })
        )
      );
    }
    return set;
  }

  /** Why no grant could be derived, in words that quote no secret. */
  #whyNoGrant(error: unknown): string {
    if (error instanceof LeaseVaultError) return error.message;
    return (
      `A Gateway Grant for this lease could not be derived, so nothing was sealed and ` +
      `nothing was sent: ${messageOf(error)}`
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Planning one packet                                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * Where a handover goes, who collects, and from which channel.
   *
   * The gateway's ILP address, its pinned sealing key and the handover's price
   * all come from the gateway connector's own `GET /ilp`. Nothing here is a
   * constant — the only thing the profile contributes is the URL to ask.
   *
   * Which connector pays follows #93's rule exactly: **a route the gateway
   * prices at zero is bought where it is zero**, because a forwarding hop's
   * own fee would quietly make a free message cost money. On devnet that is
   * the gateway's own connector, which terminates its own route and charges
   * nothing; a network whose hub one day carries the prefix at zero would be
   * chosen instead, with no release here.
   */
  async #plan(
    lease: LeaseView,
    problems: string[],
    wanted?: string | undefined,
    atConnector?: string | undefined
  ): Promise<GatewayPlan | undefined> {
    const profile = this.#deps.profile();
    if (lease.profileId !== profile.id) {
      problems.push(
        `This lease was bought on ${lease.profileId} and the console is on ${profile.id}. ` +
          `Switch networks to act on it: its gateway, its channel and its provider are all ` +
          `that network's.`
      );
      return undefined;
    }

    const gatewayUrl = atConnector ?? profile.gatewayConnectorUrl;
    if (gatewayUrl.length === 0) {
      problems.push(
        `${profile.label} names no Workload Gateway, so there is nowhere to hand this workload ` +
          `to. A gateway is chosen by sealing a packet to its connector (ADR 0017); the profile ` +
          `is where this console keeps which one.`
      );
      return undefined;
    }
    // A gateway's connector at a `.anyone` address is reached over a circuit
    // or not at all, by the same rule as a Hidden Provider's (spec §10,
    // TOON_Network#98). Resolved before the health read, because that read is
    // itself a dial.
    let socksProxy: string | undefined;
    if (isHiddenServiceUrl(gatewayUrl)) {
      const carriage = this.#deps.hidden;
      if (carriage === undefined) {
        problems.push(
          `${gatewayUrl} is a hidden service, reachable only over an Anyone Protocol circuit, ` +
            `and this build has no carriage for one (spec §10).`
        );
        return undefined;
      }
      try {
        socksProxy = (await carriage.open()).socksProxy;
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

    // Every packet is signed by a payer key, free routes included.
    const seed = await this.#seed();
    if (seed.state !== 'ready' && seed.state !== 'not_yet_recoverable') {
      problems.push(
        seed.state === 'signed_out'
          ? 'No account is signed in, so there is no key to sign a packet with and no lease to act on.'
          : (seed.reason ??
              'This account has no readable Chain Seed, so it has no payer key on any chain — ' +
                'and every packet, free route included, is signed by one. Mint or import one on ' +
                'the Account tab.')
      );
      return undefined;
    }

    const health = await this.#deps.readHealth({ ...profile, connectorUrl: gatewayUrl });
    if (health.state !== 'ok') {
      problems.push(
        `The Workload Gateway's connector at ${gatewayUrl} did not answer${
          health.state === 'unreachable' ? `: ${health.reason}` : '.'
        } Its own \`GET /ilp\` is where this console reads the gateway's route and the key a ` +
          `handover is sealed to, so nothing can be sealed until it does.`
      );
      return undefined;
    }

    const found = handoverRouteOf(health);
    if (found === undefined) {
      problems.push(
        `The connector at ${gatewayUrl} publishes no handover route. It terminates ` +
          `${health.routes.map((entry) => entry.prefix).join(', ') || 'nothing'}, and a Gateway ` +
          `Handover goes to \`<ilp address>.handover\` (spec §12.1). This is a connector, but ` +
          `it is not a Workload Gateway's.`
      );
      return undefined;
    }
    const sealTo = health.edgeSealKey;
    if (sealTo === undefined || sealTo.length === 0) {
      problems.push(
        `The connector at ${gatewayUrl} publishes no sealing key, so a handover cannot be ` +
          `sealed to it. A gateway signs nothing and publishes no Provider Profile (ADR 0017), ` +
          `so its own \`GET /ilp\` is the only thing that names its key.`
      );
      return undefined;
    }

    // The same two candidates a lease op weighs: this network's own connector
    // when it carries the prefix, and the terminating one — which always does.
    const candidates: { url: string; via: OpRouteView['via'] }[] = [];
    if (isConfigured(profile) && profile.connectorUrl !== gatewayUrl) {
      candidates.push({ url: profile.connectorUrl, via: 'profile-connector' });
    }
    candidates.push({ url: gatewayUrl, via: 'provider-connector' });

    const priced: {
      url: string;
      via: OpRouteView['via'];
      price: string;
      health: Extract<ConnectorHealth, { state: 'ok' }>;
    }[] = [];
    const refusals: string[] = [];
    for (const candidate of candidates) {
      const edge =
        candidate.url === gatewayUrl
          ? health
          : await this.#deps.readHealth({ ...profile, connectorUrl: candidate.url });
      if (edge.state !== 'ok') {
        refusals.push(
          `The connector at ${candidate.url} did not answer${
            edge.state === 'unreachable' ? `: ${edge.reason}` : '.'
          }`
        );
        continue;
      }
      const quoted = edge.routes.find((published) =>
        routeCarries(published.prefix, found.route)
      )?.price;
      if (quoted === undefined) {
        refusals.push(
          `The connector at ${candidate.url} prices no route carrying ${found.route}, so it ` +
            `cannot carry this packet.`
        );
        continue;
      }
      priced.push({ ...candidate, price: quoted, health: edge });
    }

    if (priced.length === 0) {
      problems.push(
        `There is no connector this console can reach that carries ${found.route}. ` +
          refusals.join(' ')
      );
      return undefined;
    }

    const free = priced.find((candidate) => candidate.price === '0');
    const chosen =
      free ?? priced.find((candidate) => candidate.via === 'profile-connector') ?? priced[0];
    if (chosen === undefined) return undefined;
    const reason =
      chosen === free
        ? `${chosen.url} prices ${found.route} at nothing, so this packet is bought where it is ` +
          `free (spec §5, §12). A connector that merely forwards charges its own fee to carry it.`
        : chosen.via === 'profile-connector'
          ? `${profile.label}'s own connector publishes a route that carries ${found.route}, so ` +
            `the packet is paid there and forwarded.`
          : `${profile.label}'s connector publishes no route carrying ${found.route}, so the ` +
            `packet is paid at the gateway's own connector, which terminates it.`;

    const channels = channelStoreFor(this.#deps.paths, profile.id);
    const base = {
      route: found.route,
      ilpAddress: found.ilpAddress,
      // Where to pay is the connector's OWN name for itself, not the URL
      // this console dialled: the client keys a channel binding by the
      // string it is configured with, and a connector that answers on
      // `localhost` and `127.0.0.1` alike publishes only one of them
      // (TOON_Network#126, found again on this path by #101).
      payAt: chosen.health.selfEndpoint,
      via: chosen.via,
      reason,
      price: chosen.price,
      // ADR 0011's rule, applied to a gateway: the key the TERMINATING edge
      // publishes, never one a hop offered on its behalf.
      sealTo,
      gatewayUrl,
      channelStore: channels.store,
      ...(socksProxy === undefined ? {} : { socksProxy }),
      ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
    };

    const settlements = orderChains(chosen.health.settlements, wanted ?? lease.paidChain);
    for (const settlement of settlements) {
      const binding = findChannelBinding(
        channels.store,
        chosen.health.selfEndpoint,
        settlement.chain
      );
      if (!binding) continue;
      const rpcUrl = resolveRpc(profile, settlement.kind).url;
      return {
        ...base,
        chain: settlement.chain,
        channelId: binding.channelId,
        chainKind: settlement.kind,
        rpcUrl,
        ...(socksProxy === undefined ? {} : { proxyRpc: await proxyRpcFor(rpcUrl) }),
        ...optional('available', channelAvailable(channels.store, binding)),
      } as GatewayPlan;
    }

    const first = settlements[0];
    if (chosen.price !== '0') {
      problems.push(
        `One handover on ${found.route} costs ${chosen.price} base units at ${chosen.url}, and ` +
          `this account holds no payment channel there. Open one on ` +
          `${chosen.health.settlements.map((entry) => entry.chain).join(' or ') || 'its settlement chain'}` +
          ` from the Funds tab — nothing here opens one for you, because opening locks ` +
          `collateral on chain and costs the chain's own gas.`
      );
    }
    const fallbackRpc = resolveRpc(profile, first?.kind ?? 'evm').url;
    return {
      ...base,
      chainKind: first?.kind ?? 'evm',
      rpcUrl: fallbackRpc,
      ...(socksProxy === undefined ? {} : { proxyRpc: await proxyRpcFor(fallbackRpc) }),
    } as GatewayPlan;
  }

  /* ------------------------------------------------------------------------ */
  /* Reading a request                                                        */
  /* ------------------------------------------------------------------------ */

  /** The moment the grants are derived for, checked against this clock. */
  #expiry(request: HandoverRequest, problems: string[]): number | undefined {
    if (request.expiresAt !== undefined && request.expiresIn !== undefined) {
      problems.push(
        'A handover names one moment: `expiresAt` (unix seconds) or `expiresIn` (seconds from ' +
          'now), not both. Which of them was meant decides the grant, and a grant derived for ' +
          'the wrong moment is `bad_grant` at every member.'
      );
      return undefined;
    }
    const now = this.#seconds();
    const at = request.expiresAt ?? now + (request.expiresIn ?? DEFAULT_GRANT_SECONDS);
    if (!Number.isSafeInteger(at)) {
      problems.push('`expiresAt` is unix seconds as a whole number.');
      return undefined;
    }
    if (at <= now) {
      // §12.1: a gateway refuses an expired handover `grant_expired` without
      // asking anybody, and a grant expiring this second is expired by the
      // time the gateway holds it.
      problems.push(
        `A grant derived for ${new Date(at * 1000).toISOString()} is already out of force. The ` +
          `gateway refuses that \`grant_expired\` before it asks anybody (spec §12.1), so ` +
          `nothing was derived and nothing was sent.`
      );
      return undefined;
    }
    return at;
  }

  /**
   * Which container port the gateway forwards to (§12.4 step 5).
   *
   * Named rather than guessed when the spawn asked for more than one, because
   * a gateway forwards to the `host_port` whose `container_port` equals this
   * and to nothing else: the wrong one is a hostname that answers a person's
   * database instead of their app, with nothing to say it went wrong.
   */
  #httpPort(lease: LeaseView, wanted: number | undefined, problems: string[]): number {
    const ports = lease.ports.map((port) => port.container_port);
    if (wanted === undefined) {
      const only = ports.length === 1 ? ports[0] : undefined;
      if (only !== undefined) return only;
      problems.push(
        ports.length === 0
          ? `This lease's spawn asked for no ports, so there is nothing for a gateway to ` +
              `forward to. A workload reached by hostname publishes the port it serves HTTP on.`
          : `This spawn asked for ${ports.join(', ')}. Say which one carries HTTP: a gateway ` +
              `forwards to the host port mapped from that container port and to no other ` +
              `(spec §12.4).`
      );
      return 0;
    }
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) {
      problems.push(
        `${JSON.stringify(wanted)} is not a port: a whole number from 1 to 65535.`
      );
      return 0;
    }
    if (ports.length > 0 && !ports.includes(wanted)) {
      problems.push(
        `This spawn asked for ${ports.join(', ')} and not ${wanted}, so the provider maps no ` +
          `host port to it and the gateway would have nothing to forward to (spec §12.4).`
      );
      return 0;
    }
    return wanted;
  }

  /** §12.6's readable label. A bad one costs the grant nothing — so refuse it here. */
  #name(wanted: string | undefined, problems: string[]): string | undefined {
    if (wanted === undefined || wanted === '') return undefined;
    if (!DNS_LABEL.test(wanted)) {
      problems.push(
        `${JSON.stringify(wanted)} is not a name a gateway can serve: one DNS label, 1 to 63 ` +
          `lowercase letters, digits and hyphens, no leading or trailing hyphen and no dots ` +
          `(spec §12.6). A gateway would log it and ignore it, leaving the workload at its ` +
          `canonical hostname — so it is refused here instead, where it can be corrected.`
      );
      return undefined;
    }
    return wanted;
  }

  /* ------------------------------------------------------------------------ */
  /* Views                                                                    */
  /* ------------------------------------------------------------------------ */

  async #view(lease: LeaseView, serving?: ServingView | undefined): Promise<GatewayView> {
    const checkedAt = this.#at().toISOString();
    const problems: string[] = [];
    const planned = await this.#plan(lease, problems);
    const held = this.#noteFor(lease.workloadId);
    const hostname = hostnameFor(lease.workloadId, this.#deps.profile().gatewayDomain);
    const ports = lease.ports.map((port) => port.container_port);
    const defaulted = ports.length === 1 ? ports[0] : undefined;
    const expired = held === undefined ? undefined : held.expiresAt <= this.#seconds();
    return {
      workloadId: lease.workloadId,
      ...optional('hostname', hostname),
      ...(planned === undefined
        ? {}
        : {
            gateway: {
              connectorUrl: planned.gatewayUrl,
              ilpAddress: planned.ilpAddress,
              route: planned.route,
              ...optional('price', planned.price),
              domain: this.#deps.profile().gatewayDomain,
            },
          }),
      ...optional('handover', held),
      held: held !== undefined && held.withdrawnAt === undefined && expired !== true,
      ...optional(
        'expired',
        held === undefined || held.withdrawnAt !== undefined ? undefined : expired
      ),
      problems,
      ok: planned !== undefined && problems.length === 0,
      ports,
      ...optional('httpPort', held?.httpPort ?? defaulted),
      ...optional('serving', serving),
      checkedAt,
    };
  }

  /** An ordinary HTTPS request to the name, exactly as a browser would make it. */
  async #knock(hostname: string): Promise<ServingView> {
    const at = this.#at().toISOString();
    let answer: ProbeAnswer;
    try {
      answer = await this.#deps.probe.knock(probeUrlFor(hostname));
    } catch (error) {
      return {
        kind: 'unreachable',
        message:
          `${hostname} did not answer: ${messageOf(error)} That is DNS or the network rather ` +
          `than a grant — a gateway that holds nothing still answers, with \`no_grant\` ` +
          `(spec §12.3).`,
        at,
      };
    }
    if (answer.reason === 'no_grant') {
      return {
        kind: 'no_grant',
        message:
          `${hostname} names no workload this gateway holds a grant for. That is the healthy ` +
          `empty state (spec §12.3): it is what the name answers before its first handover, ` +
          `and again after a withdrawal.`,
        at,
      };
    }
    if (answer.reason !== undefined) {
      return {
        kind: 'refused',
        reason: answer.reason,
        status: answer.status,
        message: servingWords(answer.reason, hostname),
        at,
      };
    }
    return {
      kind: 'serving',
      status: answer.status,
      ...optional('excerpt', answer.excerpt),
      at,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Odds and ends                                                            */
  /* ------------------------------------------------------------------------ */

  #lease(workloadId: string): LeaseView {
    if (!HEX_32.test(workloadId)) {
      throw new GatewayError(
        'invalid_workload_id',
        'A workload id is 32 bytes as 64 lowercase hex characters (spec §6.2).'
      );
    }
    const held = this.#deps.vault.find(workloadId);
    if (held === undefined) {
      throw new GatewayError(
        'unknown_workload',
        `This account holds no lease for workload ${workloadId}. Without its Root Secret ` +
          `nothing can derive a Gateway Grant for it (spec §6.5.1), so it cannot be handed to ` +
          `a gateway or withdrawn from one.`,
        404
      );
    }
    return held;
  }

  /** One packet, signed by the account's payer key — free routes included. */
  async #send(plan: GatewayPlan, body: unknown): Promise<PacketOutcome> {
    return this.#deps.chainSeed.usePayerKeys((keys) =>
      this.#deps.gateway.send({
        payAt: plan.payAt,
        sealTo: plan.sealTo,
        route: plan.route,
        body,
        chainKind: plan.chainKind,
        rpcUrl: plan.rpcUrl,
        keys,
        channelStore: plan.channelStore,
        ...(plan.socksProxy === undefined ? {} : { socksProxy: plan.socksProxy }),
        ...(plan.proxyRpc === undefined ? {} : { proxyRpc: plan.proxyRpc }),
        ...(plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs }),
      })
    );
  }

  /**
   * The Chain Seed's state, having actually LOOKED for it.
   *
   * `unknown` is not `absent`, for the reason `workload.ts` gives: a freshly
   * started daemon has not asked its relays yet, and refusing every packet
   * until something does would refuse them all on the first screen.
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

  #noteFor(workloadId: string): GatewayNote | undefined {
    const pubkey = this.#deps.vault.status().pubkey;
    if (pubkey === undefined) return undefined;
    return this.#deps.notes.read(pubkey, workloadId)?.gateway;
  }

  #note(workloadId: string, gateway: GatewayNote): void {
    const pubkey = this.#deps.vault.status().pubkey;
    if (pubkey === undefined) return;
    this.#deps.notes.write(pubkey, workloadId, { gateway });
  }

  #at(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  #seconds(): number {
    return Math.floor(this.#at().getTime() / 1000);
  }
}

/* -------------------------------------------------------------------------- */
/* One planned packet                                                         */
/* -------------------------------------------------------------------------- */

interface GatewayPlan {
  readonly route: string;
  readonly ilpAddress: string;
  readonly payAt: string;
  readonly via: OpRouteView['via'];
  readonly reason: string;
  readonly price?: string | undefined;
  readonly chain?: string | undefined;
  readonly channelId?: string | undefined;
  readonly available?: bigint | undefined;
  readonly sealTo: string;
  readonly gatewayUrl: string;
  readonly chainKind: 'evm' | 'solana';
  readonly rpcUrl: string;
  readonly channelStore: Parameters<ProviderPort['send']>[0]['channelStore'];
  /** Set only when the gateway's own connector is a `.anyone` address (§10). */
  readonly socksProxy?: string | undefined;
  readonly proxyRpc?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * The gateway's route, from its connector's own self-description.
 *
 * A Workload Gateway's connector terminates `<ilp address>.handover` and, on
 * every gateway built so far, that one route and nothing else (§12.1). Finding
 * it by matching the published prefix against `<address>.handover` — rather
 * than taking `ilpAddresses[0]` and hoping — is what makes this work against a
 * connector that one day fronts a gateway beside something else.
 */
function handoverRouteOf(
  health: Extract<ConnectorHealth, { state: 'ok' }>
): { ilpAddress: string; route: string } | undefined {
  for (const address of health.ilpAddresses) {
    const route = `${address}.handover`;
    if (health.routes.some((published) => routeCarries(published.prefix, route))) {
      return { ilpAddress: address, route };
    }
  }
  return undefined;
}

/**
 * The gateway's answer, in the two shapes §12.1 and §12.7 allow.
 *
 * Success is `{ workload_id, hostname, … }`; a refusal is §5's two-key error
 * shape. **The body is the contract and the HTTP status is not**, so what is
 * read is `error` — and a code this build has never heard of is carried
 * through rather than refused, because §12 says a reader must not refuse one.
 */
export function readGatewayAnswer(outcome: PacketOutcome): {
  hostname?: string | undefined;
  expiresAt?: number | undefined;
  withdrawn?: boolean | undefined;
  error?: string | undefined;
  message?: string | undefined;
} {
  if (outcome.kind === 'refused') {
    // A reject from the edge or a hop never reached the gateway app at all.
    return {
      error: outcome.code,
      message: `${
        outcome.refusedBy === 'edge'
          ? 'The connector this console sends through refused the packet before routing it'
          : outcome.refusedBy === 'path'
            ? 'A hop on the way refused the packet'
            : 'The gateway’s own connector refused the packet'
      }: ${outcome.message} Nothing reached the gateway.`,
    };
  }
  if (outcome.kind !== 'answered') return {};
  const body = outcome.body;
  if (typeof body !== 'object' || body === null) {
    return {
      error: 'unreadable_answer',
      message:
        `The gateway answered HTTP ${outcome.status} with something this console cannot read ` +
        `as either a handover answer or a refusal (spec §12.1).`,
    };
  }
  const fields = body as Record<string, unknown>;
  if (typeof fields['error'] === 'string') {
    return {
      error: fields['error'],
      ...(typeof fields['message'] === 'string' ? { message: fields['message'] } : {}),
    };
  }
  return {
    ...(typeof fields['hostname'] === 'string' ? { hostname: fields['hostname'] } : {}),
    ...(typeof fields['expires_at'] === 'number' ? { expiresAt: fields['expires_at'] } : {}),
    ...(fields['withdrawn'] === true ? { withdrawn: true } : {}),
  };
}

/**
 * What a gateway's refusal means, in a sentence that says what to do.
 *
 * §12.1 and §12.7 keep their codes apart on purpose — `not_admitted` is a fact
 * about the grant, `admission_failed` a fact about the gateway — and these
 * words keep them apart too. A code this build does not know is quoted rather
 * than flattened.
 */
export function refusalWords(code: string, message?: string | undefined): string {
  const tail = message === undefined ? '' : ` The gateway said: ${message}`;
  switch (code) {
    case 'not_admitted':
      return (
        `The gateway asked every member of this lease's Standby Set and none of them accepted ` +
        `the grant, so it is serving nothing and the handover was dropped (spec §12.1). Since ` +
        `TOON_Network#114 a gateway refuses a grant it cannot prove, so this is a fact about ` +
        `the LEASE: its token was rotated since, no member still holds this workload, or none ` +
        `of them is answering. Ask the workload's status — that is free — before deriving ` +
        `another grant.${tail}`
      );
    case 'grant_expired':
      return (
        `The moment this handover named has already passed, so the gateway refused it without ` +
        `asking anybody (spec §12.1). Hand over again with a later moment.${tail}`
      );
    case 'rate_limited':
      return (
        `The gateway will not ask one of this lease's providers again just now: it rate-limits ` +
        `admission per member named, so that a burst of handovers cannot be aimed at a ` +
        `provider (spec §12.1, ADR 0017). Nothing was sent to anybody. Try again shortly.${tail}`
      );
    case 'not_withdrawn':
      return (
        `The gateway is not serving this workload under the grant this withdrawal bore: a ` +
        `different grant, one it has since replaced, or a workload it holds nothing for. ` +
        `Nothing changed and nobody was asked (spec §12.7).${tail}`
      );
    case 'invalid_handover':
    case 'invalid_withdrawal':
      return (
        `The gateway could not read this message (spec §12.1). Nothing was asked of any ` +
        `provider. This is a fault in the console rather than in the lease — please report ` +
        `it with the sentence below.${tail}`
      );
    case 'no_proxy':
      return (
        `A member of this lease's Standby Set is a Hidden Provider, and this gateway has no ` +
        `anon client to reach one with. Nothing was dialled (spec §12.8).${tail}`
      );
    case 'admission_failed':
    case 'withdrawal_failed':
      return (
        `The gateway could not carry the request out at all, so nothing was decided about the ` +
        `grant (spec §12.1). That is the gateway rather than this lease; it is worth sending ` +
        `again.${tail}`
      );
    default:
      return `The gateway refused this message: ${code}.${tail}`;
  }
}

/** §12.3's reasons, as a person reads them at their own hostname. */
function servingWords(reason: string, hostname: string): string {
  switch (reason) {
    case 'grant_expired':
      return (
        `The grant ${hostname} was served under has run out, so the gateway stopped serving it ` +
        `(spec §12.3). Hand the workload over again with a later moment and the name works ` +
        `once more — the gateway holds the readable label meanwhile.`
      );
    case 'not_resolved':
      return `The gateway holds a grant for ${hostname} but has not yet found where the workload runs.`;
    case 'no_running_member':
      return (
        `Every member of this lease's Standby Set answered the gateway and none of them is ` +
        `running the workload (spec §12.3). That is the lease rather than the gateway: the ` +
        `workload has stopped, ended, or a Takeover has not finished.`
      );
    case 'member_unreachable':
      return (
        `A member that would answer told the gateway nothing — its connector did not answer, ` +
        `refused the request, or answered something that is not a status at all (spec §12.3, ` +
        `ADR 0023). This is carriage rather than a statement about the workload.`
      );
    case 'no_proxy':
      return `The workload is on a Hidden Provider and this gateway has no anon client to reach one (spec §12.8).`;
    default:
      return `${hostname} answered ${reason}.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Small shared shapes                                                        */
/* -------------------------------------------------------------------------- */

function route(plan: GatewayPlan | undefined): { route?: OpRouteView } {
  if (plan === undefined) return {};
  return {
    route: {
      route: plan.route,
      payAt: plan.payAt,
      via: plan.via,
      reason: plan.reason,
      ...optional('price', plan.price),
      ...optional('chain', plan.chain),
      ...optional('channelId', plan.channelId),
    },
  };
}

function costOf(outcome: PacketOutcome): string | undefined {
  return outcome.kind === 'unknown' ? undefined : outcome.cost;
}

/**
 * The chain a lease was BOUGHT on first, for the reason `workload.ts` gives:
 * a connector that has to convert refuses a packet whose amount converts to
 * nothing, at full price. It matters here only on a network whose handover
 * route is not free, and it is spelled the same way there so that the two
 * cannot drift.
 */
function orderChains<T extends { chain: string }>(
  settlements: readonly T[],
  wanted: string | undefined
): readonly T[] {
  if (wanted === undefined) return settlements;
  const preferred = settlements.filter((entry) => entry.chain === wanted);
  return [...preferred, ...settlements.filter((entry) => entry.chain !== wanted)];
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
