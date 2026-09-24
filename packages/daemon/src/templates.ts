import { npubEncode } from 'nostr-tools/nip19';

import { LABEL } from './directory.js';
import { tagValue, type NostrEvent, type NostrFilter } from './nostr.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import { queryRelays, type RelayOutcome, type RelayQuery } from './relay-pool.js';
import { DIGEST, ENV_NAME } from './spawn-content.js';

/**
 * The Template gallery (spec §8.3, §8.1, §8.2).
 *
 * A **Template** is a signed, published description of a spawn: an image by
 * content address, its ports, its fixed settings and the settings a tenant may
 * set. It GRANTS NO CAPABILITY (ADR 0004) — capabilities come from a Listing
 * and from nowhere else — and in v1 the **tenant** expands it into a spawn: a
 * provider never reads one, and a spawn's `template` field is informational
 * (§8.3, §11 item 5). So everything this ticket does happens on this side of
 * the wire, before a single µUSDC moves.
 *
 * WHAT IS READ, and why three kinds rather than one:
 *
 * - kind `30436`, the Template itself, signed by its PUBLISHER — a key with no
 *   standing in the protocol at all. A Template is not an offer, nobody has to
 *   honour it, and a publisher is not a provider. That is precisely why the
 *   signature matters: the gallery is a list of strangers' claims about what an
 *   account is about to run, and `relay-pool.ts` has already re-derived each
 *   event's id and checked its `sig` before anything here sees it (#91).
 * - kind `30434`, the Image Registry entry a Template's image names, which
 *   lists every blob of that image and where the bytes of each one live (§8.1).
 * - kind `30435`, a Blob Record, for a Template that names its image by digest
 *   alone: §8.4 step 3 finds those bytes by `#x` on relays.
 *
 * WHAT "RESOLVED" MEANS HERE, and what it does not. ADR 0006 puts the
 * integrity of an image in its DIGEST, wherever the bytes are stored, and the
 * party that fetches and verifies them is the provider (§8.4). The console
 * fetches no image bytes: a gallery that downloaded every layer of every
 * Template to decide whether to draw a card would cost an account its evening.
 * What it checks is the RECORDS, which is free over the same relay read, and
 * it says so on the card:
 *
 * - an entry that is on no relay read, or is not signed by the pubkey its own
 *   address names, resolves nothing;
 * - an entry whose `digest` disagrees with the Template's is a different image;
 * - a blob whose `source.type` is one this reader does not know is refused
 *   rather than skipped (§8.1), because skipping it would call an image
 *   resolvable that is missing a layer;
 * - a Blob Record carrying both `parts` and `pages`, or neither, is invalid and
 *   names no bytes at all (§8.2).
 *
 * A Template that fails any of those is shown as **unavailable** with the
 * reason, and is not offered for spawning. One that passes is offered — and
 * the provider still verifies every byte against the digest before it runs
 * anything, which is the check that actually protects the account.
 *
 * NO NETWORK CONSTANT. The relay a read starts from is the active profile's;
 * every other relay comes off the wire in a Template's own `registry_entry`
 * hint, and a hint is dialled only if it is a websocket URL.
 */

/** Image Registry entry, addressable by `<name>:<tag>` (spec §8.1). */
export const K_IMAGE = 30434;
/** Blob Record, addressable by `sha256:<hex>` (spec §8.2). */
export const K_BLOB = 30435;
/** Template, addressable by its name (spec §8.3). */
export const K_TEMPLATE = 30436;
/** NIP-01 metadata, for putting a name to a publisher's key. */
const K_METADATA = 0;

/**
 * How many relays a read will dial beyond the profile's own.
 *
 * Every hint is a URL a stranger published, and a gallery of five hundred
 * Templates would otherwise be five hundred sockets opened by whoever wrote
 * them. ADR 0022 makes a provider refuse a tenant's relay hint that is not
 * publicly routable; the console is not a provider — its own sandbox profile
 * points at loopback on purpose — so the defence here is a cap and a scheme
 * check rather than an address check.
 */
const MAX_HINT_RELAYS = 8;

export interface TemplatePort {
  readonly containerPort: number;
  readonly protocol: 'tcp' | 'udp';
}

/** §4.2's `resources`, read as a FLOOR for choosing a Listing (§8.3). */
export interface TemplateResources {
  readonly cpuMillicores: number;
  readonly memoryMb: number;
  readonly storageGb: number;
  readonly gpu?: string;
}

export interface RegistryEntryRef {
  /** `30434:<pubkey>:<name>:<tag>`, verbatim from the Template. */
  readonly address: string;
  /** The publisher's hint for where to find the entry, if it gave one. */
  readonly relay?: string;
}

export interface TemplateImage {
  readonly digest: string;
  readonly registryEntry?: RegistryEntryRef;
}

/** A Template's content, parsed (spec §8.3). */
export interface TemplateContent {
  readonly version: number;
  readonly image: TemplateImage;
  readonly ports: readonly TemplatePort[];
  /** Where the image keeps its data. Informational: see `template-spawn.ts`. */
  readonly dataPath?: string;
  /** Settings the publisher fixed. Shown, never editable. */
  readonly envFixed: Readonly<Record<string, string>>;
  /** The names — and only these — a tenant may set (§8.3). */
  readonly envTenant: readonly string[];
  readonly minResources?: TemplateResources;
  /**
   * Whether this Template's image is claimed to serve SSH, informational and
   * NOT part of §8.3's content shape.
   *
   * §6.2 requires `ssh_public_key` on every spawn regardless — the provider
   * always forwards `access.ssh_port` to the container's port 22, whether or
   * not anything is listening there (TOON_Network#138). A Template names no
   * SSH capability at all in the spec (ADR 0004: it grants none), so there is
   * nothing here to check a signature or a provider against. This is a plain
   * extra key a publisher MAY put in its content — `ssh_offered: false` — to
   * say plainly that the image it names has no sshd, so the gallery and the
   * New workload form stop asking for a key nobody could use and stop
   * promising an `ssh` command that will be refused. Absent, or anything
   * other than the literal `false`, means what every Template has always
   * meant: this console cannot say either way, so it keeps asking.
   */
  readonly sshOffered: boolean;
}

export interface BlobSourceStore {
  readonly type: 'toon-store';
  /** The Blob Record's own upload in the TOON store (ADR 0006). */
  readonly blobRecordTxid: string;
}

export interface BlobSourceOci {
  readonly type: 'oci';
  readonly registry: string;
  readonly repository: string;
}

export type BlobSource = BlobSourceStore | BlobSourceOci;

export interface ImageBlob {
  readonly digest: string;
  readonly size: number;
  readonly mediaType: string;
  readonly source: BlobSource;
}

export interface ImageEntryView {
  /** `30434:<pubkey>:<name>:<tag>` — how the Template named it. */
  readonly address: string;
  /** `<publisher npub>/<name>:<tag>`, §8.1's canonical name for the image. */
  readonly canonicalName: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly blobs: readonly ImageBlob[];
  /** Whose entry it is: the pubkey its own address names, and nobody else's. */
  readonly signer: string;
  readonly publishedAt: string;
  readonly eventId: string;
}

/** One blob's part list, as §8.2's two shapes reduce to (ADR 0006). */
export interface BlobRecordView {
  readonly digest: string;
  readonly size: number;
  readonly partSize: number;
  /** `inline` carries its parts; `paged` names the uploads that carry them. */
  readonly shape: 'inline' | 'paged';
  /** How many parts the record names, pages counted through. */
  readonly parts: number;
  readonly publishedAt: string;
  readonly eventId: string;
  /** Whoever uploaded the parts. Not trusted: the digest is (ADR 0006). */
  readonly signer: string;
}

export type TemplateAvailability =
  | {
      readonly state: 'available';
      /** What was actually checked, so the card cannot overclaim. */
      readonly checked: string;
      readonly entry?: ImageEntryView;
      readonly blobRecord?: BlobRecordView;
    }
  | { readonly state: 'unavailable'; readonly reason: string };

export interface PublisherView {
  readonly pubkey: string;
  readonly npub: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly picture?: string;
  readonly nip05?: string;
}

export interface TemplateView extends TemplateContent {
  /** The `d` tag: the publisher's name for this Template. */
  readonly name: string;
  /** `30436:<pubkey>:<name>` — what a spawn's `template` field will carry. */
  readonly address: string;
  readonly publisher: PublisherView;
  readonly availability: TemplateAvailability;
  /** Things worth saying that do not make the Template unusable. */
  readonly warnings: readonly string[];
  readonly publishedAt: string;
  readonly eventId: string;
}

/** A 30436 that is not a Template, and the reason it is not shown. */
export interface RejectedTemplate {
  readonly address: string;
  readonly name: string;
  readonly reason: string;
}

export interface TemplateGalleryView {
  readonly state: 'ok';
  readonly relays: {
    readonly seed: readonly string[];
    readonly read: readonly RelayOutcome[];
  };
  readonly templates: readonly TemplateView[];
  readonly rejected: readonly RejectedTemplate[];
  /** Events a relay served that were not their author's. */
  readonly rejectedEvents: number;
  readonly readAt: string;
}

export type TemplateGalleryResult =
  TemplateGalleryView | { readonly state: 'unconfigured'; readonly reason: string };

export interface TemplateDeps {
  readonly profile: NetworkProfile;
  readonly now?: Date;
  /** Injected in tests; the default opens real sockets. */
  readonly query?: (query: RelayQuery) => Promise<Awaited<ReturnType<typeof queryRelays>>>;
  readonly timeoutMs?: number;
}

/**
 * Read the gallery.
 *
 * TWO passes, for the same reason the Provider Directory has two (#91): the
 * first finds what exists, and only then is it known what else to ask for. A
 * Template names its Image Registry entry by address and MAY name a relay to
 * find it on, and a publisher's kind-0 cannot be asked for before its pubkey
 * is known.
 */
export async function readTemplates(deps: TemplateDeps): Promise<TemplateGalleryResult> {
  const { profile } = deps;
  if (profile.relayUrl.length === 0 || !isConfigured(profile)) {
    return {
      state: 'unconfigured',
      reason: `${profile.label} names no relay yet, so there are no Templates to read.`,
    };
  }

  const now = deps.now ?? new Date();
  const run = deps.query ?? queryRelays;
  const timeout = deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs };
  const seed = [profile.relayUrl];

  const first = await run({
    relays: seed,
    filters: [{ kinds: [K_TEMPLATE], '#L': [LABEL] }],
    ...timeout,
  });

  const templateEvents = current(first.events, K_TEMPLATE);
  const parsed = templateEvents.map((event) => ({
    event,
    content: readTemplateContent(event),
  }));

  // What pass two has to go and get: the entry each Template names, the Blob
  // Records a digest-alone Template needs, and a name for each publisher.
  const entryCoordinates: { pubkey: string; d: string }[] = [];
  const digests = new Set<string>();
  const publishers = new Set<string>();
  const hints = new Set<string>();

  for (const { event, content } of parsed) {
    publishers.add(event.pubkey);
    if ('reason' in content) continue;
    const ref = content.image.registryEntry;
    if (ref === undefined) {
      digests.add(content.image.digest.slice('sha256:'.length));
      continue;
    }
    const coordinate = parseCoordinate(ref.address, K_IMAGE);
    if (coordinate !== undefined) entryCoordinates.push(coordinate);
    if (ref.relay !== undefined && isWebsocketUrl(ref.relay) && !seed.includes(ref.relay)) {
      hints.add(ref.relay);
    }
  }

  const relays = [...seed, ...[...hints].slice(0, MAX_HINT_RELAYS)];
  const filters = secondPassFilters({
    entries: entryCoordinates,
    digests: [...digests],
    publishers: [...publishers],
  });
  const second = filters.length === 0 ? undefined : await run({ relays, filters, ...timeout });

  const reads = second === undefined ? [first] : [first, second];
  const events = reads.flatMap((read) => [...read.events]);
  const seenOn = relaysThatCarried(reads);

  const entries = current(events, K_IMAGE);
  const blobRecords = current(events, K_BLOB);
  const metadata = current(events, K_METADATA);

  const templates: TemplateView[] = [];
  const rejected: RejectedTemplate[] = [];

  for (const { event, content } of parsed) {
    const name = tagValue(event, 'd') ?? '';
    const address = `${K_TEMPLATE}:${event.pubkey}:${name}`;
    if ('reason' in content) {
      rejected.push({ address, name, reason: content.reason });
      continue;
    }
    templates.push({
      ...content,
      name,
      address,
      publisher: readPublisher(event.pubkey, metadata),
      availability: resolveImage(content.image, { entries, blobRecords, seenOn }),
      warnings: warningsFor(content),
      publishedAt: new Date(event.created_at * 1000).toISOString(),
      eventId: event.id,
    });
  }

  // Spawnable first, then by name: a person opening the gallery is looking for
  // something to run, and a Template they cannot run is a footnote.
  templates.sort(
    (left, right) =>
      Number(right.availability.state === 'available') -
        Number(left.availability.state === 'available') || left.name.localeCompare(right.name)
  );

  return {
    state: 'ok',
    relays: { seed, read: dedupeOutcomes(reads.flatMap((read) => [...read.relays])) },
    templates,
    rejected,
    rejectedEvents: reads.reduce((total, read) => total + read.rejected, 0),
    readAt: now.toISOString(),
  };
}

function secondPassFilters(wanted: {
  entries: readonly { pubkey: string; d: string }[];
  digests: readonly string[];
  publishers: readonly string[];
}): NostrFilter[] {
  const filters: NostrFilter[] = [];
  if (wanted.entries.length > 0) {
    // A cross product of authors and `d`s, narrowed again locally: NIP-01 has
    // no way to say "this author's THIS d, and that author's THAT d", and a
    // relay that answers more than it was asked does not decide what is shown.
    filters.push({
      kinds: [K_IMAGE],
      authors: [...new Set(wanted.entries.map((entry) => entry.pubkey))],
      '#d': [...new Set(wanted.entries.map((entry) => entry.d))],
    });
  }
  if (wanted.digests.length > 0) {
    // §8.4 step 3: Blob Records are found by `#x`, whoever signed them. The
    // hex ALONE, with no `sha256:` prefix (§8.1, §8.2).
    filters.push({ kinds: [K_BLOB], '#x': [...wanted.digests] });
  }
  if (wanted.publishers.length > 0) {
    filters.push({ kinds: [K_METADATA], authors: [...wanted.publishers] });
  }
  return filters;
}

/**
 * A Template's content, or the reason this event is not one.
 *
 * Strict, because everything downstream treats what comes out of here as
 * something an account may be shown and offered a button for. A Template that
 * cannot be turned into a valid spawn is not a Template with a problem, it is
 * not a Template.
 */
export function readTemplateContent(
  event: NostrEvent
): TemplateContent | { readonly reason: string } {
  const name = tagValue(event, 'd');
  if (name === undefined || name.length === 0) {
    return { reason: 'it carries no `d` tag, so it has no name to be addressed by' };
  }

  const content = parseObject(event.content);
  if (content === undefined) return { reason: 'its content is not a JSON object' };

  const version = asInteger(content.version);
  if (version === undefined) return { reason: 'its content names no integer `version`' };

  const image = readTemplateImage(content.image);
  if ('reason' in image) return image;

  const ports = readPorts(content.ports);
  if ('reason' in ports) return ports;

  const envFixed = readEnvFixed(content.env_fixed);
  if ('reason' in envFixed) return envFixed;

  const envTenant = readEnvTenant(content.env_tenant);
  if ('reason' in envTenant) return envTenant;

  const dataPath = asString(content.data_path);
  const minResources = readResources(content.min_resources);

  return {
    version,
    image,
    ports: ports.value,
    ...(dataPath === undefined ? {} : { dataPath }),
    envFixed: envFixed.value,
    envTenant: envTenant.value,
    ...(minResources === undefined ? {} : { minResources }),
    // Only an explicit `false` opts out; anything else keeps today's answer.
    sshOffered: content.ssh_offered !== false,
  };
}

/**
 * §8.3's image: the registry-entry or digest-alone form, NEVER the upstream
 * one. "A Template names an image by content address" is the whole point of
 * the kind — an `{ reference, digest }` Template would be a Template that
 * sends an account to Docker Hub, and the console will not draw a card for it.
 */
function readTemplateImage(value: unknown): TemplateImage | { readonly reason: string } {
  const image = asObject(value);
  if (image === undefined) return { reason: 'its `image` is not an object' };

  const digest = asString(image.digest);
  if (digest === undefined || !DIGEST.test(digest)) {
    return {
      reason: 'its `image.digest` is not `sha256:` and 64 lowercase hex characters',
    };
  }
  if (image.reference !== undefined) {
    return {
      reason:
        'its `image` carries a `reference`: a Template names an image by content address, ' +
        'never as an upstream pull (§8.3)',
    };
  }
  if (image.registry_entry === undefined) return { digest };

  const entry = asObject(image.registry_entry);
  const address = entry === undefined ? undefined : asString(entry.address);
  if (address === undefined || parseCoordinate(address, K_IMAGE) === undefined) {
    return {
      reason: `its \`image.registry_entry.address\` is not a \`${K_IMAGE}:<pubkey>:<name>:<tag>\` coordinate`,
    };
  }
  const relay = entry === undefined ? undefined : asString(entry.relay);
  if (relay !== undefined && !isWebsocketUrl(relay)) {
    return { reason: 'its `image.registry_entry.relay` is not a `ws://` or `wss://` URL' };
  }
  return {
    digest,
    registryEntry: { address, ...(relay === undefined ? {} : { relay }) },
  };
}

function readPorts(
  value: unknown
): { readonly value: TemplatePort[] } | { readonly reason: string } {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value)) return { reason: 'its `ports` is not an array' };
  const ports: TemplatePort[] = [];
  for (const entry of value) {
    const port = asObject(entry);
    const containerPort = port === undefined ? undefined : asInteger(port.container_port);
    const protocol = port === undefined ? undefined : asString(port.protocol);
    if (containerPort === undefined || containerPort < 1 || containerPort > 65_535) {
      return { reason: 'one of its `ports` names no `container_port` in 1–65535' };
    }
    if (protocol !== 'tcp' && protocol !== 'udp') {
      return { reason: 'one of its `ports` names a protocol that is neither `tcp` nor `udp`' };
    }
    ports.push({ containerPort, protocol });
  }
  return { value: ports };
}

function readEnvFixed(
  value: unknown
): { readonly value: Record<string, string> } | { readonly reason: string } {
  if (value === undefined) return { value: {} };
  const record = asObject(value);
  if (record === undefined) return { reason: 'its `env_fixed` is not an object' };
  const env: Record<string, string> = {};
  for (const [key, held] of Object.entries(record)) {
    if (!ENV_NAME.test(key)) {
      return {
        reason: `its \`env_fixed\` names \`${clip(key)}\`, which is not a variable name`,
      };
    }
    if (typeof held !== 'string') {
      return { reason: `its \`env_fixed.${key}\` is not a string` };
    }
    env[key] = held;
  }
  return { value: env };
}

function readEnvTenant(
  value: unknown
): { readonly value: string[] } | { readonly reason: string } {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value)) return { reason: 'its `env_tenant` is not an array' };
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !ENV_NAME.test(entry)) {
      return {
        reason: `its \`env_tenant\` lists \`${clip(String(entry))}\`, which is not a variable name`,
      };
    }
    if (!names.includes(entry)) names.push(entry);
  }
  return { value: names };
}

function readResources(value: unknown): TemplateResources | undefined {
  const resources = asObject(value);
  if (resources === undefined) return undefined;
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
 * Things a person should know that do not stop a Template being spawned.
 *
 * A name in BOTH `env_fixed` and `env_tenant` is the one that matters: §8.3
 * does not say which wins, and the console has to choose. It chooses the fixed
 * one — a publisher that pinned `MODE=production` and then listed `MODE` as
 * settable has contradicted itself, and honouring the pin is the reading that
 * cannot surprise anybody. `template-spawn.ts` refuses to set such a name, and
 * the gallery does not offer it.
 */
function warningsFor(content: TemplateContent): string[] {
  const clash = content.envTenant.filter((name) => name in content.envFixed);
  const warnings: string[] = [];
  if (clash.length > 0) {
    warnings.push(
      `${clash.join(', ')} ${clash.length === 1 ? 'is' : 'are'} listed as tenant-settable and ` +
        'also fixed by this Template. The fixed value is kept, and it cannot be edited.'
    );
  }
  if (content.dataPath !== undefined) {
    warnings.push(
      `This Template keeps its data at ${content.dataPath}. A spawn has no field for that path ` +
        '(§6.2), so ask for a volume and expect the provider to mount it where it mounts volumes.'
    );
  }
  return warnings;
}

/**
 * Whether the image a Template names can be resolved from what the relays hold.
 *
 * The two forms are resolved differently because the spec resolves them
 * differently (§8.4). With an entry, the entry is the authority on where every
 * blob's bytes are, so the question is whether the entry is really there, is
 * really the signer's, is really about this digest, and names a source type
 * this reader understands for every blob. With a digest alone there is no
 * entry: the bytes are found by asking relays for Blob Records tagged with the
 * digest, so the question is whether such a record exists here and is
 * well-formed.
 *
 * Neither branch fetches a byte, and the answer says so.
 */
export function resolveImage(
  image: TemplateImage,
  held: {
    entries: readonly NostrEvent[];
    blobRecords: readonly NostrEvent[];
    seenOn: ReadonlySet<string>;
  }
): TemplateAvailability {
  const hex = image.digest.slice('sha256:'.length);

  if (image.registryEntry !== undefined) {
    const ref = image.registryEntry;
    const coordinate = parseCoordinate(ref.address, K_IMAGE);
    if (coordinate === undefined) {
      return {
        state: 'unavailable',
        reason: `\`${clip(ref.address)}\` is not an entry address`,
      };
    }
    const event = held.entries.find(
      (candidate) =>
        candidate.pubkey === coordinate.pubkey && tagValue(candidate, 'd') === coordinate.d
    );
    if (event === undefined) {
      return {
        state: 'unavailable',
        reason:
          `Its Image Registry entry \`${ref.address}\` was on none of the relays read` +
          (ref.relay === undefined
            ? ' (the Template names no relay to look on).'
            : `, including the \`${ref.relay}\` the Template names.`),
      };
    }
    const entry = readImageEntry(event, ref.address);
    if ('reason' in entry) return { state: 'unavailable', reason: entry.reason };
    if (entry.digest !== image.digest) {
      return {
        state: 'unavailable',
        reason:
          `Its entry \`${ref.address}\` is about ${entry.digest}, not the ${image.digest} the ` +
          'Template carries: that address names a different image.',
      };
    }
    return {
      state: 'available',
      checked:
        'Its Image Registry entry was read from a relay, verified as the signature of the key ' +
        `its own address names, and names a source for each of its ${entry.blobs.length} ` +
        `blob${entry.blobs.length === 1 ? '' : 's'}. The bytes themselves are fetched and ` +
        'checked against this digest by the provider (ADR 0006, §8.4).',
      entry,
    };
  }

  const found = held.blobRecords
    .filter((event) => tagValue(event, 'x') === hex)
    .map((event) => readBlobRecord(event));
  const usable = found.find((record): record is BlobRecordView => !('reason' in record));
  if (usable === undefined) {
    const why = found.find((record) => 'reason' in record) as { reason: string } | undefined;
    return {
      state: 'unavailable',
      reason:
        `The Template names ${image.digest} with no Image Registry entry, and ` +
        (why === undefined
          ? `no Blob Record for it was on ${describe(held.seenOn)} (§8.4 step 3).`
          : `the Blob Record for it that was found is invalid: ${why.reason}.`),
    };
  }
  return {
    state: 'available',
    checked:
      `No entry: its bytes are found by digest. A Blob Record naming ${usable.parts} part` +
      `${usable.parts === 1 ? '' : 's'} of ${usable.size} bytes was read from a relay — though a ` +
      'provider looks on ITS OWN Relay Set (§8.4 step 3), which need not be this one. The parts ' +
      'are fetched and checked against this digest by the provider (ADR 0006).',
    blobRecord: usable,
  };
}

/** An Image Registry entry (§8.1), or the reason it resolves nothing. */
export function readImageEntry(
  event: NostrEvent,
  address: string
): ImageEntryView | { readonly reason: string } {
  const d = tagValue(event, 'd') ?? '';
  const content = parseObject(event.content);
  if (content === undefined) {
    return { reason: `Its Image Registry entry \`${address}\` has no JSON content.` };
  }
  const digest = asString(content.digest);
  if (digest === undefined || !DIGEST.test(digest)) {
    return { reason: `Its Image Registry entry \`${address}\` names no image digest.` };
  }
  const blobs = content.blobs;
  if (!Array.isArray(blobs) || blobs.length === 0) {
    return { reason: `Its Image Registry entry \`${address}\` lists no blobs.` };
  }

  const read: ImageBlob[] = [];
  for (const entry of blobs) {
    const blob = asObject(entry);
    const blobDigest = blob === undefined ? undefined : asString(blob.digest);
    const size = blob === undefined ? undefined : asInteger(blob.size);
    const mediaType = blob === undefined ? undefined : asString(blob.media_type);
    if (blobDigest === undefined || !DIGEST.test(blobDigest) || size === undefined) {
      return {
        reason: `Its Image Registry entry \`${address}\` lists a blob with no digest or size.`,
      };
    }
    const source = readBlobSource(blob?.source);
    if (source === undefined) {
      // §8.1: "a reader MUST refuse a source type it does not know rather than
      // skip the blob". Skipping would call an image resolvable that is short
      // a layer, and the account would find that out after paying.
      return {
        reason:
          `Its Image Registry entry \`${address}\` gives blob ${blobDigest} a source this ` +
          'console does not know, and §8.1 refuses an unknown source rather than skipping it.',
      };
    }
    read.push({ digest: blobDigest, size, mediaType: mediaType ?? '', source });
  }

  return {
    address,
    canonicalName: `${npubEncode(event.pubkey)}/${d}`,
    digest,
    mediaType: asString(content.media_type) ?? '',
    blobs: read,
    signer: event.pubkey,
    publishedAt: new Date(event.created_at * 1000).toISOString(),
    eventId: event.id,
  };
}

function readBlobSource(value: unknown): BlobSource | undefined {
  const source = asObject(value);
  if (source === undefined) return undefined;
  const type = asString(source.type);
  if (type === 'toon-store') {
    const blobRecordTxid = asString(source.blob_record_txid);
    return blobRecordTxid === undefined ? undefined : { type, blobRecordTxid };
  }
  if (type === 'oci') {
    const registry = asString(source.registry);
    const repository = asString(source.repository);
    if (registry === undefined || repository === undefined) return undefined;
    return { type, registry, repository };
  }
  return undefined;
}

/**
 * A Blob Record (§8.2), or the reason it names no bytes.
 *
 * The one-of rule is the whole of it: a record carries EITHER `parts` or
 * `pages`, never both and never neither, and a record that breaks it is not a
 * record whose good half can be used — "no reader trusts either field of it".
 * The arithmetic below is the rest: the part count a record's own `size` and
 * `part_size` imply is the count it must have, which is what stops a record
 * forcing a reader through an unbounded number of page reads (§8.4, #79).
 */
export function readBlobRecord(
  event: NostrEvent
): BlobRecordView | { readonly reason: string } {
  const content = parseObject(event.content);
  if (content === undefined) return { reason: 'its content is not a JSON object' };

  const digest = asString(content.digest);
  const size = asInteger(content.size);
  const partSize = asInteger(content.part_size);
  if (digest === undefined || !DIGEST.test(digest)) {
    return { reason: 'it names no `sha256:` digest' };
  }
  if (size === undefined || size <= 0) return { reason: 'it names no positive `size`' };
  if (partSize === undefined || partSize <= 0) {
    return { reason: 'it names no positive `part_size`' };
  }

  const hasParts = Array.isArray(content.parts);
  const hasPages = Array.isArray(content.pages);
  if (hasParts === hasPages) {
    return {
      reason: hasParts
        ? 'it carries both `parts` and `pages`, and §8.2 allows exactly one'
        : 'it carries neither `parts` nor `pages`',
    };
  }

  const expected = Math.ceil(size / partSize);
  const base = {
    digest,
    size,
    partSize,
    publishedAt: new Date(event.created_at * 1000).toISOString(),
    eventId: event.id,
    signer: event.pubkey,
  };

  if (hasParts) {
    const parts = content.parts as unknown[];
    let total = 0;
    for (const entry of parts) {
      const part = asObject(entry);
      const partBytes = part === undefined ? undefined : asInteger(part.size);
      const sha256 = part === undefined ? undefined : asString(part.sha256);
      const txid = part === undefined ? undefined : asString(part.txid);
      if (partBytes === undefined || sha256 === undefined || txid === undefined) {
        return { reason: 'one of its `parts` names no txid, sha256 or size' };
      }
      if (!/^[0-9a-f]{64}$/u.test(sha256)) {
        return { reason: 'one of its `parts` has a `sha256` that is not 32 bytes of hex' };
      }
      total += partBytes;
    }
    if (parts.length !== expected) {
      return {
        reason: `it names ${parts.length} parts where its own size and part size need ${expected}`,
      };
    }
    if (total !== size) {
      return { reason: `its parts sum to ${total} bytes, not the ${size} it claims` };
    }
    return { ...base, shape: 'inline', parts: parts.length };
  }

  const pages = content.pages as unknown[];
  let counted = 0;
  for (const entry of pages) {
    const page = asObject(entry);
    const parts = page === undefined ? undefined : asInteger(page.parts);
    const sha256 = page === undefined ? undefined : asString(page.sha256);
    const txid = page === undefined ? undefined : asString(page.txid);
    if (parts === undefined || parts <= 0 || sha256 === undefined || txid === undefined) {
      return { reason: 'one of its `pages` names no txid, sha256 or part count' };
    }
    if (!/^[0-9a-f]{64}$/u.test(sha256)) {
      return { reason: 'one of its `pages` has a `sha256` that is not 32 bytes of hex' };
    }
    counted += parts;
  }
  if (counted !== expected) {
    return {
      reason: `its pages name ${counted} parts where its own size and part size need ${expected}`,
    };
  }
  return { ...base, shape: 'paged', parts: counted };
}

function readPublisher(pubkey: string, metadata: readonly NostrEvent[]): PublisherView {
  const npub = npubEncode(pubkey);
  const event = metadata.find((candidate) => candidate.pubkey === pubkey);
  const content = event === undefined ? undefined : parseObject(event.content);
  if (content === undefined) return { pubkey, npub };
  return {
    pubkey,
    npub,
    // A kind-0 is a stranger's JSON and the console renders it: strings only,
    // and short ones (`account-metadata.ts` keeps the same rule).
    ...pick('name', content.name),
    ...pick('displayName', content.display_name),
    ...pick('picture', content.picture),
    ...pick('nip05', content.nip05),
  };
}

function pick<K extends string>(key: K, value: unknown): Record<K, string> | object {
  return typeof value === 'string' && value.length > 0
    ? ({ [key]: value.slice(0, 512) } as Record<K, string>)
    : {};
}

/**
 * `<kind>:<pubkey>:<d>`, split into AT MOST three parts.
 *
 * §6.2 says it in so many words: an Image Registry entry's `d` is itself
 * `<name>:<tag>`, so the coordinate has four colon-separated fields and the
 * `d` keeps its own colon. A reader that split on every colon would look for
 * an entry named `web` and never find one.
 */
export function parseCoordinate(
  address: string,
  kind: number
): { pubkey: string; d: string } | undefined {
  const first = address.indexOf(':');
  if (first < 0) return undefined;
  const second = address.indexOf(':', first + 1);
  if (second < 0) return undefined;
  if (address.slice(0, first) !== String(kind)) return undefined;
  const pubkey = address.slice(first + 1, second);
  const d = address.slice(second + 1);
  if (!/^[0-9a-f]{64}$/u.test(pubkey) || d.length === 0) return undefined;
  return { pubkey, d };
}

/** NIP-01's replacement rule, per author and `d`: the current version only. */
function current(events: readonly NostrEvent[], kind: number): NostrEvent[] {
  const held = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.kind !== kind) continue;
    const key = `${event.pubkey}:${tagValue(event, 'd') ?? ''}`;
    const known = held.get(key);
    if (
      known === undefined ||
      event.created_at > known.created_at ||
      (event.created_at === known.created_at && event.id < known.id)
    ) {
      held.set(key, event);
    }
  }
  return [...held.values()];
}

function relaysThatCarried(
  reads: readonly { relays: readonly RelayOutcome[] }[]
): Set<string> {
  const answered = new Set<string>();
  for (const read of reads) {
    for (const outcome of read.relays) {
      if (outcome.state !== 'failed') answered.add(outcome.url);
    }
  }
  return answered;
}

function dedupeOutcomes(outcomes: readonly RelayOutcome[]): RelayOutcome[] {
  const byUrl = new Map<string, RelayOutcome>();
  for (const outcome of outcomes) {
    const held = byUrl.get(outcome.url);
    if (held === undefined || (held.state === 'read' && outcome.state !== 'read')) {
      byUrl.set(outcome.url, outcome);
    }
  }
  return [...byUrl.values()];
}

function describe(relays: ReadonlySet<string>): string {
  if (relays.size === 0) return 'any relay that answered';
  return [...relays].join(', ');
}

function isWebsocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

/** `npub1abcd…wxyz`: enough to recognise, short enough to read. */
export function shortNpub(npub: string): string {
  return npub.length <= 20 ? npub : `${npub.slice(0, 10)}…${npub.slice(-6)}`;
}

function clip(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 64)}…`;
}

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}
