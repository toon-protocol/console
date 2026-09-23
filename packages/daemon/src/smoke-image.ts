/**
 * The image `smoke-console` puts behind a Template (TOON_Network#101).
 *
 * A Template names its image **by content address** (spec §8.3): a digest and
 * an Image Registry entry (§8.1) that says where each of that image's blobs
 * really lives. It may not name an upstream `reference`, and
 * `template-spawn.ts` is where that rule is enforced. So a smoke that wants to
 * prove the Template path needs an entry on the relay, and this file is how it
 * gets one without a TOON store, a publisher or a fixture somebody else keeps
 * alive.
 *
 * It reads a public OCI registry the ordinary way — `GET /v2/<repo>/manifests/`
 * for the index and the platform manifest — and turns the result into an entry
 * whose every blob carries `source: { type: "oci", … }`. §8.1 allows exactly
 * that, the provider fetches indexes and manifests from `/manifests/` and
 * everything else from `/blobs/`, and the bytes are still checked against the
 * digest by whoever runs them (ADR 0006). Nothing is uploaded and nothing is
 * mirrored: the entry is a signed statement about where bytes already are.
 *
 * The image is an ARGUMENT with a default, never a constant this file decides:
 * `--image` picks another, and `smoke-console.test.ts` drives the mapping with
 * fixtures rather than a network.
 */

const INDEX_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
];

const MANIFEST_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];

const ACCEPT = [...INDEX_TYPES, ...MANIFEST_TYPES].join(', ');

/** One blob of an Image Registry entry (§8.1), in the shape that is signed. */
export interface EntryBlob {
  readonly digest: string;
  readonly size: number;
  readonly media_type: string;
  readonly source: {
    readonly type: 'oci';
    readonly registry: string;
    readonly repository: string;
  };
}

/** An Image Registry entry's content (§8.1), as `templates.ts` reads it back. */
export interface EntryContent {
  readonly digest: string;
  readonly media_type: string;
  readonly blobs: readonly EntryBlob[];
}

/** A reference split into the three things a registry request needs. */
export interface ImageRef {
  readonly registry: string;
  readonly repository: string;
  readonly tag: string;
}

/**
 * `traefik/whoami:v1.10.2` → Docker Hub's `library`-less two-part form; a
 * reference with a dotted or ported first segment names its own registry.
 *
 * Deliberately small: this understands a tag and not a digest, because what a
 * Template wants is the manifest digest for ONE platform and that is resolved
 * below rather than supplied.
 */
export function parseImageRef(reference: string, defaultRegistry: string): ImageRef {
  const [name, tag = 'latest'] = splitTag(reference);
  const parts = name.split('/');
  const first = parts[0] ?? '';
  const hasRegistry = parts.length > 1 && (first.includes('.') || first.includes(':'));
  const registry = hasRegistry ? first : defaultRegistry;
  const rest = hasRegistry ? parts.slice(1) : parts;
  const repository = rest.length === 1 ? `library/${rest[0]}` : rest.join('/');
  return { registry, repository, tag };
}

function splitTag(reference: string): [string, string | undefined] {
  const at = reference.lastIndexOf(':');
  if (at < 0) return [reference, undefined];
  // A port in a registry host is not a tag: `host:5000/name` has no `/` after
  // the colon, so the colon that starts a tag is the one with none.
  if (reference.slice(at).includes('/')) return [reference, undefined];
  return [reference.slice(0, at), reference.slice(at + 1)];
}

/**
 * Pick the platform manifest out of an index.
 *
 * `arch` is the Listing's, verbatim — a Listing publishes `arch` (§4.4) and
 * buying an amd64 lease with an arm64 manifest is a way to pay for a workload
 * that cannot start. `os` is `linux` because a TOON provider runs containers.
 */
export function pickPlatform(
  index: unknown,
  arch: string
): { digest: string; mediaType: string } | undefined {
  const manifests = (index as { manifests?: unknown }).manifests;
  if (!Array.isArray(manifests)) return undefined;
  for (const entry of manifests) {
    const record = entry as {
      digest?: unknown;
      mediaType?: unknown;
      platform?: { architecture?: unknown; os?: unknown };
    };
    if (record.platform?.architecture !== arch || record.platform.os !== 'linux') continue;
    if (typeof record.digest !== 'string' || typeof record.mediaType !== 'string') continue;
    return { digest: record.digest, mediaType: record.mediaType };
  }
  return undefined;
}

/**
 * A platform manifest, its own bytes included, as §8.1's blob list.
 *
 * The manifest itself is the FIRST blob and carries the entry's own digest —
 * that is the shape every Image Registry entry on this network has, because a
 * reader that could not fetch the manifest could not find the config or the
 * layers either.
 */
export function entryFromManifest(options: {
  readonly manifest: unknown;
  readonly manifestDigest: string;
  readonly manifestMediaType: string;
  readonly manifestSize: number;
  readonly registry: string;
  readonly repository: string;
}): EntryContent {
  const source = {
    type: 'oci' as const,
    registry: options.registry,
    repository: options.repository,
  };
  const manifest = options.manifest as {
    config?: { digest?: unknown; size?: unknown; mediaType?: unknown };
    layers?: unknown;
  };
  const blobs: EntryBlob[] = [
    {
      digest: options.manifestDigest,
      size: options.manifestSize,
      media_type: options.manifestMediaType,
      source,
    },
  ];

  const config = manifest.config;
  if (
    typeof config?.digest !== 'string' ||
    typeof config.size !== 'number' ||
    typeof config.mediaType !== 'string'
  ) {
    throw new Error('that manifest names no config blob, so it describes no image');
  }
  blobs.push({
    digest: config.digest,
    size: config.size,
    media_type: config.mediaType,
    source,
  });

  const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  if (layers.length === 0) {
    throw new Error('that manifest lists no layers, so it describes no filesystem');
  }
  for (const layer of layers) {
    const record = layer as { digest?: unknown; size?: unknown; mediaType?: unknown };
    if (
      typeof record.digest !== 'string' ||
      typeof record.size !== 'number' ||
      typeof record.mediaType !== 'string'
    ) {
      throw new Error('that manifest lists a layer with no digest, size or media type');
    }
    blobs.push({
      digest: record.digest,
      size: record.size,
      media_type: record.mediaType,
      source,
    });
  }

  return {
    digest: options.manifestDigest,
    media_type: options.manifestMediaType,
    blobs,
  };
}

/**
 * Read a public registry and build the entry.
 *
 * Anonymous pull only: a `401` carrying a `Www-Authenticate: Bearer realm=…`
 * is answered by asking that realm for a pull token, which is how Docker Hub
 * serves everybody who has not logged in. A registry that wants credentials is
 * refused out loud rather than retried — a smoke has no business holding one.
 */
export async function readOciEntry(
  reference: string,
  arch: string,
  options: { readonly defaultRegistry?: string; readonly fetchImpl?: typeof fetch } = {}
): Promise<{ ref: ImageRef; entry: EntryContent }> {
  const call = options.fetchImpl ?? fetch;
  const ref = parseImageRef(reference, options.defaultRegistry ?? 'registry-1.docker.io');
  const base = `https://${ref.registry}/v2/${ref.repository}`;
  let token: string | undefined;

  const get = async (what: string): Promise<Response> => {
    const headers: Record<string, string> = { accept: ACCEPT };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const first = await call(`${base}/manifests/${what}`, { headers });
    if (first.status !== 401 || token !== undefined) return first;
    token = await pullToken(first.headers.get('www-authenticate'), call);
    return call(`${base}/manifests/${what}`, {
      headers: { accept: ACCEPT, authorization: `Bearer ${token}` },
    });
  };

  const top = await get(ref.tag);
  if (!top.ok) {
    throw new Error(
      `${ref.registry}/${ref.repository}:${ref.tag} answered ${top.status} — this smoke pulls ` +
        'anonymously and holds no registry credentials.'
    );
  }
  const topType = top.headers.get('content-type') ?? '';
  const topBody: unknown = await top.json();

  let digest = top.headers.get('docker-content-digest') ?? '';
  let mediaType = topType;
  let size = Number(top.headers.get('content-length') ?? 0);
  let manifest = topBody;

  if (INDEX_TYPES.some((type) => topType.startsWith(type))) {
    const chosen = pickPlatform(topBody, arch);
    if (chosen === undefined) {
      throw new Error(
        `${reference} is a multi-platform index with no linux/${arch} manifest in it, and a ` +
          "Listing's `arch` is what a lease is bought for (§4.4)."
      );
    }
    const platform = await get(chosen.digest);
    if (!platform.ok) {
      throw new Error(`its linux/${arch} manifest answered ${platform.status}`);
    }
    manifest = await platform.json();
    digest = chosen.digest;
    mediaType = chosen.mediaType;
    size = Number(platform.headers.get('content-length') ?? 0);
  }

  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`${reference} resolved to no \`sha256:\` manifest digest`);
  }

  return {
    ref,
    entry: entryFromManifest({
      manifest,
      manifestDigest: digest,
      manifestMediaType: mediaType,
      manifestSize: size,
      registry: ref.registry,
      repository: ref.repository,
    }),
  };
}

async function pullToken(challenge: string | null, call: typeof fetch): Promise<string> {
  const realm = /realm="([^"]+)"/u.exec(challenge ?? '')?.[1];
  const service = /service="([^"]+)"/u.exec(challenge ?? '')?.[1];
  const scope = /scope="([^"]+)"/u.exec(challenge ?? '')?.[1];
  if (realm === undefined) {
    throw new Error('that registry asked for credentials this smoke does not hold');
  }
  const url = new URL(realm);
  if (service !== undefined) url.searchParams.set('service', service);
  if (scope !== undefined) url.searchParams.set('scope', scope);
  const answer = await call(url.toString());
  if (!answer.ok) throw new Error(`its token endpoint answered ${answer.status}`);
  const body = (await answer.json()) as { token?: unknown; access_token?: unknown };
  const token = typeof body.token === 'string' ? body.token : body.access_token;
  if (typeof token !== 'string') throw new Error('its token endpoint returned no token');
  return token;
}
