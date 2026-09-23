import {
  CurrentEvents,
  expirationOf,
  tagValue,
  tagValues,
  type NostrEvent,
  type NostrFilter,
} from './nostr.js';
import {
  isHiddenServiceUrl,
  type AnonCarriage,
  type HiddenTransportPort,
} from './hidden-transport.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import {
  hiddenAwareDialer,
  queryRelays,
  type RelayOutcome,
  type RelayQuery,
} from './relay-pool.js';

/**
 * The Provider Directory (spec §4).
 *
 * Reading it is free and needs no identity: the console opens a relay, sends a
 * REQ and assembles what comes back. Nothing here spawns, pays or signs —
 * that is #90, #89 and #88.
 *
 * Three kinds are read TOGETHER, because none of them means anything alone.
 * A Provider Profile (10432) says who a provider is, where its connector is
 * and which relays it publishes to. A Listing (30432) is one sellable tier and
 * its price, and it is a separate event on purpose (ADR 0002) so a price
 * change does not rewrite the identity. A Liveness (10433) is the short-lived
 * claim that the provider is up at all (ADR 0007). A Listing whose Profile
 * cannot be found is not purchasable (§4.2), so the Profile is what a provider
 * row is built around and its Listings hang off it.
 *
 * TWO PASSES, and the second one is the point. The console knows one relay for
 * a network — the seed the active profile names — but a provider publishes to
 * its OWN Relay Set (§4), which is a fact only its Profile carries. So the
 * first pass finds Profiles on the seed relay, and the second goes back to
 * each provider's own relays for that provider's own events. A provider whose
 * seed-relay copy is stale, or whose Liveness only ever reaches its own
 * relays, is then read correctly; a Listing version that is current on one
 * relay and superseded on another resolves the same way whichever answered
 * first, because the winner is chosen here by NIP-01's rule and not by arrival
 * order.
 *
 * NOTHING in this file is a network constant. The seed relay comes from the
 * active profile, every other relay comes off the wire in a Profile, and a
 * provider's connector, ILP address and settlement chains are read from its
 * Profile rather than assumed (TOON_Network#87's house rule).
 */

/** Provider Profile, replaceable (spec §4.1). */
export const K_PROFILE = 10432;
/** Liveness, replaceable and expiring (spec §4.3). */
export const K_LIVENESS = 10433;
/** Listing, addressable by its `d` tag (spec §4.2). */
export const K_LISTING = 30432;

/** The label every published TOON Network event carries (spec §4). */
export const LABEL = 'toon.network';

/** The isolation values §4.4 defines. Anything else is a provider's own word. */
export const ISOLATIONS = ['shared-kernel', 'dedicated-host'] as const;
/** The architectures §4.4 defines. */
export const ARCHITECTURES = ['amd64', 'arm64'] as const;
/** The capabilities §4.4 has specified. An unspecified one is never read as one of these. */
export const KNOWN_CAPABILITIES = ['docker', 'nesting'] as const;

/**
 * §4.4's GPU label grammar, in full: `<vendor>-<model>`, lowercase, hyphenated.
 * A value that breaks it MUST be ignored rather than guessed at, which is why
 * this is a check and not a parse.
 */
const GPU_LABEL = /^(nvidia|amd|intel|apple)(-[a-z0-9]+)+$/;

/** `gpu=any` asks for a GPU without naming one; a relay cannot express it. */
export const ANY_GPU = 'any';

export interface DirectoryFilters {
  readonly isolation?: string | undefined;
  readonly arch?: string | undefined;
  /** A full `<vendor>-<model>` label, or `any` for "some GPU". */
  readonly gpu?: string | undefined;
  /** Every one of these must be granted, not any of them. */
  readonly capabilities?: readonly string[] | undefined;
  /** `true` wants Hidden Providers only, `false` excludes them, unset shows both. */
  readonly hidden?: boolean | undefined;
}

export interface ProviderProfileView {
  readonly ilpAddress: string;
  readonly connectorUrl: string;
  readonly connectorSealKey: string;
  /** The provider's own Relay Set (§4), verbatim. */
  readonly relays: readonly string[];
  readonly settlement: readonly SettlementTerm[];
  readonly isolation: string;
  readonly hidden: boolean;
  /** Absent for a Hidden Provider, which MUST NOT publish one (§4.1, §10). */
  readonly host?: string;
  readonly livenessCadenceSeconds?: number;
  readonly publishedAt: string;
  readonly eventId: string;
}

export interface SettlementTerm {
  readonly chain: string;
  readonly token: string;
  readonly decimals: number;
}

export interface ListingResources {
  readonly cpuMillicores: number;
  readonly memoryMb: number;
  readonly storageGb: number;
  /** One device of this model, when the tier sells a GPU (§4.2). */
  readonly gpu?: string;
}

export interface ListingView {
  /** The `d` tag: the provider's own name for the tier, stable across versions. */
  readonly name: string;
  /** `30432:<pubkey>:<name>` — what a spawn will name (§6.1). */
  readonly address: string;
  /** Rises on every price or resource change (ADR 0009). */
  readonly version: number;
  readonly resources: ListingResources;
  readonly arch: string;
  readonly isolation: string;
  readonly hidden: boolean;
  /** The Lease Interval this tier's price buys, in seconds. */
  readonly leaseIntervalSeconds: number;
  /** µUSDC for one Lease Interval of a running lease. */
  readonly price: number;
  /** µUSDC per interval for a Warm Standby; absent means this tier sells none (§4.2). */
  readonly standbyPrice?: number;
  /** Granted by the Listing alone (ADR 0004), verbatim from its content. */
  readonly capabilities: readonly string[];
  /** Those §4.4 has not specified: shown, never read as a known one. */
  readonly unspecifiedCapabilities: readonly string[];
  readonly geohash?: string;
  readonly publishedAt: string;
  readonly eventId: string;
  /** How many leases of this tier the provider says could start now (§4.3). */
  readonly available?: number;
}

export type LivenessState =
  /** An unexpired Liveness: the provider says it is up right now. */
  | 'live'
  /** A Liveness whose `expiration` has passed with no refresh. */
  | 'stale'
  /** No Liveness on any of its relays; expired ones may already be dropped. */
  | 'unknown';

export interface LivenessView {
  readonly state: LivenessState;
  readonly publishedAt?: string;
  /** The moment it stops being true, from its own `expiration` tag (§4.3). */
  readonly expiresAt?: string;
  /** Negative once it has passed; the UI counts down from here on its own. */
  readonly secondsUntilExpiry?: number;
  /** How often this provider republishes, from its Profile (§4.1). */
  readonly cadenceSeconds?: number;
}

export interface ProviderView {
  readonly pubkey: string;
  readonly profile: ProviderProfileView;
  readonly liveness: LivenessView;
  /** Current, purchasable Listings, cheapest first. */
  readonly listings: readonly ListingView[];
  /** The relays this provider's events were actually read from. */
  readonly relaysRead: readonly string[];
  /** Older Listing versions seen and set aside, so supersession is visible. */
  readonly supersededListings: number;
  /** Listings dropped as unpurchasable, and why (§4.2, §4.4). */
  readonly rejectedListings: readonly RejectedListing[];
}

export interface RejectedListing {
  readonly name: string;
  readonly reason: string;
}

export interface DirectoryView {
  readonly state: 'ok';
  readonly relays: {
    /** The relay the active network profile names: where the read starts. */
    readonly seed: readonly string[];
    /** Every relay that was asked, seed and Relay Sets together. */
    readonly read: readonly RelayOutcome[];
  };
  readonly filters: DirectoryFilters;
  readonly providers: readonly ProviderView[];
  /** Listings found whose Provider Profile was on no relay read (§4.2). */
  readonly listingsWithoutProfile: number;
  /** Events a relay served that were not their author's. */
  readonly rejectedEvents: number;
  readonly readAt: string;
}

export type DirectoryResult =
  DirectoryView | { readonly state: 'unconfigured'; readonly reason: string };

export interface DirectoryDeps {
  readonly profile: NetworkProfile;
  readonly filters?: DirectoryFilters;
  readonly now?: Date;
  /** Injected in tests; the default opens real sockets. */
  readonly query?: (query: RelayQuery) => Promise<Awaited<ReturnType<typeof queryRelays>>>;
  readonly timeoutMs?: number;
  /**
   * The Anyone Protocol carriage (#98, spec §10).
   *
   * Only the SECOND pass can need it: a Hidden Provider reaches every relay
   * through `anon`, so the Relay Set its Profile publishes is `.anyone` URLs.
   * Without one those relays are not dialled at all — see `hiddenAwareDialer`
   * for why a failed connection would be the wrong shape of failure.
   */
  readonly hidden?: HiddenTransportPort | undefined;
}

export async function readDirectory(deps: DirectoryDeps): Promise<DirectoryResult> {
  const { profile } = deps;
  if (profile.relayUrl.length === 0 || !isConfigured(profile)) {
    return {
      state: 'unconfigured',
      reason: `${profile.label} names no relay yet, so there is no directory to read.`,
    };
  }

  const now = deps.now ?? new Date();
  const filters = deps.filters ?? {};
  const run = deps.query ?? queryRelays;
  const timeout = deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs };
  const seed = [profile.relayUrl];

  const first = await run({ relays: seed, filters: directoryFilters(filters), ...timeout });

  // Pass two: each provider's OWN Relay Set, which only its Profile names.
  const relaySets = new Map<string, Set<string>>(); // relay url -> pubkeys to ask it about
  for (const event of first.events) {
    if (event.kind !== K_PROFILE) continue;
    const parsed = readProfileContent(event);
    if (parsed === undefined) continue;
    for (const url of parsed.relays) {
      if (seed.includes(url)) continue;
      const authors = relaySets.get(url) ?? new Set<string>();
      authors.add(event.pubkey);
      relaySets.set(url, authors);
    }
  }

  // Opened ONCE for the whole second pass, and only when it is needed: a
  // directory of clearnet providers never touches `anon` at all. A carriage
  // that will not open is not an error here — the `.anyone` relays in the set
  // are reported as unanswered and the rest of the pass runs (§4.2).
  const carriage = await openCarriageFor([...relaySets.keys()], deps.hidden);
  const dial = { dial: hiddenAwareDialer(carriage) };

  const second = await Promise.all(
    [...relaySets].map(([url, authors]) =>
      run({
        relays: [url],
        filters: directoryFilters(filters, [...authors]),
        ...timeout,
        ...(isHiddenServiceUrl(url) || carriage !== undefined ? dial : {}),
      })
    )
  );

  const reads = [first, ...second];
  const seenOn = new Map<string, Set<string>>(); // pubkey -> relays that carried it
  for (const read of reads) {
    const answered = read.relays
      .filter((outcome) => outcome.state !== 'failed')
      .map((o) => o.url);
    for (const event of read.events) {
      const relays = seenOn.get(event.pubkey) ?? new Set<string>();
      for (const url of answered) relays.add(url);
      seenOn.set(event.pubkey, relays);
    }
  }

  return assemble({
    events: reads.flatMap((read) => [...read.events]),
    outcomes: reads.flatMap((read) => [...read.relays]),
    rejectedEvents: reads.reduce((total, read) => total + read.rejected, 0),
    seenOn,
    seed,
    filters,
    now,
  });
}

/** The carriage, if any relay in this set needs one and one can be had. */
async function openCarriageFor(
  urls: readonly string[],
  hidden: HiddenTransportPort | undefined
): Promise<AnonCarriage | undefined> {
  if (hidden === undefined || !urls.some(isHiddenServiceUrl)) return undefined;
  try {
    return await hidden.open();
  } catch {
    return undefined;
  }
}

/**
 * The REQ a directory read sends.
 *
 * TWO filters and not one, because the tag filters only apply to Listings: a
 * Profile carries no `l` tag and a Liveness carries neither, so folding the
 * whole read into one filter would make every tag filter also a filter against
 * the Profiles that make its Listings purchasable.
 *
 * The tag filters go to the relay where NIP-01 can express them (§4.4), and
 * every one of them is checked again locally — a relay narrows the read, it
 * does not decide what a person is shown. `hidden: false` has no relay filter
 * at all, on purpose: a provider that is not hidden carries no `hidden:` label,
 * and absence is not something a filter can ask for (§4.2).
 */
export function directoryFilters(
  filters: DirectoryFilters,
  authors?: readonly string[]
): NostrFilter[] {
  const scope: NostrFilter = {
    '#L': [LABEL],
    ...(authors === undefined ? {} : { authors: [...authors] }),
  };

  const labels: string[] = [];
  if (filters.isolation) labels.push(`isolation:${filters.isolation}`);
  if (filters.arch) labels.push(`arch:${filters.arch}`);
  if (filters.gpu && filters.gpu !== ANY_GPU) labels.push(`gpu:${filters.gpu}`);
  if (filters.hidden === true) labels.push('hidden:true');

  const capabilities = filters.capabilities ?? [];

  return [
    { kinds: [K_PROFILE, K_LIVENESS], ...scope },
    {
      kinds: [K_LISTING],
      ...scope,
      // NIP-01 is OR within one tag filter and AND across them, and a `#l`
      // array would ask for "isolation OR arch". One entry per value is what
      // asks for both.
      ...(labels.length === 0 ? {} : { '#l': labels }),
      ...(capabilities.length === 0 ? {} : { '#t': [...capabilities] }),
    },
  ];
}

interface Assembly {
  readonly events: readonly NostrEvent[];
  readonly outcomes: readonly RelayOutcome[];
  readonly rejectedEvents: number;
  readonly seenOn: Map<string, Set<string>>;
  readonly seed: readonly string[];
  readonly filters: DirectoryFilters;
  readonly now: Date;
}

function assemble(input: Assembly): DirectoryView {
  const profiles = new CurrentEvents();
  const liveness = new CurrentEvents();
  const listings = new CurrentEvents();
  const supersededPerProvider = new Map<string, number>();

  for (const event of input.events) {
    if (event.kind === K_PROFILE) {
      profiles.offer(event.pubkey, event);
    } else if (event.kind === K_LIVENESS) {
      liveness.offer(event.pubkey, event);
    } else if (event.kind === K_LISTING) {
      const name = tagValue(event, 'd');
      if (name === undefined) continue;
      const before = listings.supersededCount;
      listings.offer(`${event.pubkey}:${name}`, event);
      if (listings.supersededCount !== before) {
        supersededPerProvider.set(
          event.pubkey,
          (supersededPerProvider.get(event.pubkey) ?? 0) + 1
        );
      }
    }
  }

  const perProvider = new Map<string, NostrEvent[]>();
  for (const [, event] of listings.entries()) {
    const held = perProvider.get(event.pubkey) ?? [];
    held.push(event);
    perProvider.set(event.pubkey, held);
  }

  let listingsWithoutProfile = 0;
  const providers: ProviderView[] = [];

  for (const [pubkey, events] of perProvider) {
    const profileEvent = profiles.get(pubkey);
    const profile = profileEvent === undefined ? undefined : readProfileContent(profileEvent);
    if (profileEvent === undefined || profile === undefined) {
      // "A Listing whose Provider Profile cannot be found is not purchasable"
      // (§4.2). Counted rather than dropped in silence: a provider missing
      // from the list because its Profile did not reach this relay is a fact a
      // person may need, and it is also how a broken read looks.
      listingsWithoutProfile += events.length;
      continue;
    }

    const rejected: RejectedListing[] = [];
    const current: ListingView[] = [];
    const livenessEvent = liveness.get(pubkey);
    const available = livenessEvent === undefined ? {} : readAvailable(livenessEvent);

    for (const event of events) {
      const read = readListing(event, profile, available);
      if ('reason' in read) {
        rejected.push(read);
        continue;
      }
      if (matches(read, input.filters)) current.push(read);
    }

    if (current.length === 0) continue;

    current.sort(
      (left, right) => left.price - right.price || left.name.localeCompare(right.name)
    );

    providers.push({
      pubkey,
      profile,
      liveness: readLiveness(livenessEvent, profile, input.now),
      listings: current,
      relaysRead: [...(input.seenOn.get(pubkey) ?? [])],
      supersededListings: supersededPerProvider.get(pubkey) ?? 0,
      rejectedListings: rejected,
    });
  }

  // Live providers first — a stale one cannot start a lease now — then the
  // cheapest tier each offers.
  const rank = { live: 0, unknown: 1, stale: 2 };
  providers.sort(
    (left, right) =>
      rank[left.liveness.state] - rank[right.liveness.state] ||
      (left.listings[0]?.price ?? 0) - (right.listings[0]?.price ?? 0)
  );

  return {
    state: 'ok',
    relays: { seed: input.seed, read: dedupeOutcomes(input.outcomes) },
    filters: input.filters,
    providers,
    listingsWithoutProfile,
    rejectedEvents: input.rejectedEvents,
    readAt: input.now.toISOString(),
  };
}

function dedupeOutcomes(outcomes: readonly RelayOutcome[]): RelayOutcome[] {
  const byUrl = new Map<string, RelayOutcome>();
  for (const outcome of outcomes) {
    const held = byUrl.get(outcome.url);
    // A relay asked twice — once as the seed, once as somebody's Relay Set —
    // is one row, and a failure is what a person needs to see over a success.
    if (held === undefined || (held.state === 'read' && outcome.state !== 'read')) {
      byUrl.set(outcome.url, outcome);
    }
  }
  return [...byUrl.values()];
}

/** A Provider Profile's content, or `undefined` when it is not one (§4.1). */
export function readProfileContent(event: NostrEvent): ProviderProfileView | undefined {
  const content = parseObject(event.content);
  if (content === undefined) return undefined;

  const ilpAddress = asString(content.ilp_address);
  const connectorUrl = asString(content.connector_url);
  const isolation = asString(content.isolation);
  if (ilpAddress === undefined || connectorUrl === undefined || isolation === undefined) {
    return undefined;
  }

  const hidden = content.hidden === true;
  const host = asString(content.host);
  const cadence = asInteger(content.liveness_cadence_s);

  return {
    ilpAddress,
    connectorUrl,
    connectorSealKey: asString(content.connector_seal_key) ?? '',
    relays: Array.isArray(content.relays) ? content.relays.filter(isNonEmptyString) : [],
    settlement: readSettlement(content.settlement),
    isolation,
    hidden,
    // A Hidden Provider MUST NOT publish a host (§4.1). One that does is not
    // hidden in any useful sense, and the console must not repeat the leak.
    ...(hidden || host === undefined ? {} : { host }),
    ...(cadence === undefined ? {} : { livenessCadenceSeconds: cadence }),
    publishedAt: new Date(event.created_at * 1000).toISOString(),
    eventId: event.id,
  };
}

function readSettlement(value: unknown): SettlementTerm[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const term = entry as Record<string, unknown>;
    const chain = asString(term.chain);
    const token = asString(term.token);
    const decimals = asInteger(term.decimals);
    if (chain === undefined || token === undefined || decimals === undefined) return [];
    return [{ chain, token, decimals }];
  });
}

/**
 * One Listing, or the reason it cannot be bought.
 *
 * §4.2 and §4.4 make three claims a tenant can check for itself before a
 * single µUSDC moves, and each of them is a way a person could be sold
 * something other than what they read:
 *
 * - a `gpu:` label that disagrees with `resources.gpu` — a tier that says one
 *   card in its tags and another in its content;
 * - an `l hidden:true` that its Profile does not back, or a Hidden Provider's
 *   Listing that omits it — the tag a person filters privacy by;
 * - content that is not a Listing at all.
 */
export function readListing(
  event: NostrEvent,
  profile: ProviderProfileView,
  available: Readonly<Record<string, number>> = {}
): ListingView | RejectedListing {
  const name = tagValue(event, 'd') ?? '';
  const reject = (reason: string): RejectedListing => ({ name, reason });

  const content = parseObject(event.content);
  if (content === undefined) return reject('its content is not a JSON object');

  const version = asInteger(content.version);
  const arch = asString(content.arch);
  const leaseIntervalSeconds = asInteger(content.lease_interval_s);
  const price = asInteger(content.price);
  const resources = readResources(content.resources);
  if (
    version === undefined ||
    arch === undefined ||
    leaseIntervalSeconds === undefined ||
    price === undefined ||
    resources === undefined
  ) {
    return reject('it is missing a version, arch, lease interval, price or resources');
  }

  const gpuLabel = labelValue(event, 'gpu');
  // §4.4: a value that breaks the grammar is ignored rather than guessed at,
  // which then makes it disagree with `resources.gpu` — and a Listing where
  // the two disagree is not purchasable.
  const gpu = gpuLabel !== undefined && GPU_LABEL.test(gpuLabel) ? gpuLabel : undefined;
  if ((resources.gpu ?? '') !== (gpu ?? '')) {
    return reject(
      `its \`resources.gpu\` (${resources.gpu ?? 'none'}) and its \`gpu:\` label (${gpuLabel ?? 'none'}) do not agree`
    );
  }

  const hiddenTag = labelValue(event, 'hidden') === 'true';
  if (hiddenTag !== profile.hidden) {
    return reject(
      hiddenTag
        ? 'it claims `hidden:true`, but its Provider Profile does not declare a Hidden Provider'
        : 'its Provider Profile declares a Hidden Provider, but the Listing carries no `hidden:true`'
    );
  }

  const capabilities = Array.isArray(content.capabilities)
    ? content.capabilities.filter(isNonEmptyString)
    : [];
  const standbyPrice = asInteger(content.standby_price);
  const geohash = tagValue(event, 'g');
  const isolation = labelValue(event, 'isolation') ?? profile.isolation;
  const availableNow = available[name];

  return {
    name,
    address: `${K_LISTING}:${event.pubkey}:${name}`,
    version,
    resources,
    arch,
    isolation,
    hidden: hiddenTag,
    leaseIntervalSeconds,
    price,
    // Absent — never `0` — is how a Listing says it sells no Warm Standby (§4.2).
    ...(standbyPrice === undefined ? {} : { standbyPrice }),
    capabilities,
    unspecifiedCapabilities: capabilities.filter(
      (capability) => !(KNOWN_CAPABILITIES as readonly string[]).includes(capability)
    ),
    ...(geohash === undefined ? {} : { geohash }),
    publishedAt: new Date(event.created_at * 1000).toISOString(),
    eventId: event.id,
    ...(availableNow === undefined ? {} : { available: availableNow }),
  };
}

function readResources(value: unknown): ListingResources | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const resources = value as Record<string, unknown>;
  const cpuMillicores = asInteger(resources.cpu_millicores);
  const memoryMb = asInteger(resources.memory_mb);
  const storageGb = asInteger(resources.storage_gb);
  if (cpuMillicores === undefined || memoryMb === undefined || storageGb === undefined) {
    return undefined;
  }
  const gpu = asString(resources.gpu);
  return { cpuMillicores, memoryMb, storageGb, ...(gpu === undefined ? {} : { gpu }) };
}

/**
 * Liveness, decided against `now` and not against the read.
 *
 * This is why a page ages: nothing about `live` is stored, it is recomputed
 * from the event's own `expiration` every time it is asked. A provider that
 * stops republishing goes stale on its own, with no refresh and no new event
 * (§4.3, ADR 0007) — the UI counts the same seconds down in the browser.
 */
export function readLiveness(
  event: NostrEvent | undefined,
  profile: ProviderProfileView,
  now: Date
): LivenessView {
  const cadence =
    profile.livenessCadenceSeconds === undefined
      ? {}
      : { cadenceSeconds: profile.livenessCadenceSeconds };

  if (event === undefined) return { state: 'unknown', ...cadence };

  const expiration = expirationOf(event);
  const publishedAt = new Date(event.created_at * 1000).toISOString();
  if (expiration === undefined) {
    // §4.3 requires the tag. Without it nothing says when this stops being
    // true, and a claim that never expires is not liveness.
    return { state: 'unknown', publishedAt, ...cadence };
  }

  const secondsUntilExpiry = Math.round(expiration - now.getTime() / 1000);
  return {
    state: secondsUntilExpiry > 0 ? 'live' : 'stale',
    publishedAt,
    expiresAt: new Date(expiration * 1000).toISOString(),
    secondsUntilExpiry,
    ...cadence,
  };
}

function readAvailable(event: NostrEvent): Record<string, number> {
  const content = parseObject(event.content);
  const available = content?.available;
  if (typeof available !== 'object' || available === null) return {};
  const out: Record<string, number> = {};
  for (const [name, count] of Object.entries(available as Record<string, unknown>)) {
    const parsed = asInteger(count);
    if (parsed !== undefined) out[name] = parsed;
  }
  return out;
}

/**
 * The local half of every filter.
 *
 * A relay narrowed the read; this decides. The two are not redundant: a relay
 * cannot express "carries no `hidden:` label", cannot express "some GPU,
 * whichever", and answers `#t` as OR where a person asking for `docker` AND
 * `nesting` means both. And a relay that answered something it was not asked
 * for is exactly the relay whose answer should not be shown.
 */
export function matches(listing: ListingView, filters: DirectoryFilters): boolean {
  if (filters.isolation && listing.isolation !== filters.isolation) return false;
  if (filters.arch && listing.arch !== filters.arch) return false;
  if (filters.hidden !== undefined && listing.hidden !== filters.hidden) return false;
  if (filters.gpu === ANY_GPU) {
    if (listing.resources.gpu === undefined) return false;
  } else if (filters.gpu && listing.resources.gpu !== filters.gpu) {
    return false;
  }
  // Exact values only: §4.4 forbids reading `x-docker` as `docker`, in either
  // direction and forever.
  return (filters.capabilities ?? []).every((wanted) => listing.capabilities.includes(wanted));
}

/** The value after `<name>:` of the first `l` tag that carries it (§4.4). */
function labelValue(event: NostrEvent, name: string): string | undefined {
  const prefix = `${name}:`;
  return tagValues(event, 'l')
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function asInteger(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}
