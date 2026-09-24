import type { EventTemplate } from 'nostr-tools/core';
import { npubEncode } from 'nostr-tools/nip19';

import type { NostrEvent } from './nostr.js';
import type { RelayWriter, RelayWriteTargets } from './relay-write.js';
import type { AccountSigning } from './signer.js';
import { entryFromManifest, pickPlatform, type EntryContent } from './smoke-image.js';

/**
 * Building and publishing an ssh-box Template (TOON_Network#138).
 *
 * The shape of this file is `docs-publish.ts`'s, on purpose: planning
 * (building the two events, spending nothing) is kept apart from publishing
 * (signing and paying for them) so that `--dry-run` is the SAME code path a
 * real publish takes and not a second one that could quietly drift from it,
 * and so the event-building can be unit-tested with no relay, no connector
 * and no channel — exactly what `template-publish.test.ts` does.
 *
 * Two events, both addressable (NIP-01's replaceable-per-`(kind,pubkey,d)`
 * rule), same as `smoke-console-run.ts`'s `publishTemplate` builds for its
 * own fixture image:
 *
 * - kind `30434`, the Image Registry entry (spec §8.1) — what says where
 *   the image's blobs are, one `oci` source per blob, straight off the
 *   public registry's own manifests.
 * - kind `30436`, the Template itself (spec §8.3) — `image.digest` and
 *   `image.registry_entry` naming the entry above, so a reader resolves the
 *   image exactly the way `templates.ts`'s `resolveImage` does.
 *
 * `title`, `summary` and `ssh_key` ride along in the Template's content
 * beside the fields §8.3 defines. `templates.ts`'s `readTemplateContent`
 * only ever reads the fields it knows (`version`, `image`, `ports`,
 * `env_fixed`, `env_tenant`, `data_path`, `min_resources`) and silently
 * ignores the rest, so this is forward-compatible rather than a protocol
 * violation — a future gallery card that wants a title or a one-line
 * description can read it from here with no second event, and today's
 * gallery is unaffected either way.
 */

export const REGISTRY_KIND = 30434;
export const TEMPLATE_KIND = 30436;
export const TOON_LABEL = 'toon.network';

/* -------------------------------------------------------------------------- */
/* The image reference: `registry/repository[:tag][@sha256:digest]`          */
/* -------------------------------------------------------------------------- */

export interface ParsedImageReference {
  readonly registry: string;
  readonly repository: string;
  readonly tag: string;
  /** Present when `--image` named one, which `template:publish` requires. */
  readonly digest?: string;
}

/**
 * Split an image reference into registry, repository, tag and (optionally) a
 * digest. Docker Hub's `library`-less two-part form is expanded the same way
 * `smoke-image.ts`'s `parseImageRef` does; this adds the `@sha256:…` half
 * that one does not need, because a smoke resolves by tag and a Template
 * publish resolves **by digest, always** ("The image is referenced by digest
 * at publish time").
 */
export function parseImageReference(
  reference: string,
  defaultRegistry = 'registry-1.docker.io'
): ParsedImageReference {
  const at = reference.indexOf('@');
  const namePart = at < 0 ? reference : reference.slice(0, at);
  const digest = at < 0 ? undefined : reference.slice(at + 1);
  if (digest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(
      `\`${reference}\` names a digest that is not \`sha256:\` and 64 lowercase hex characters`
    );
  }
  const [name, tag = 'latest'] = splitNameTag(namePart);
  const parts = name.split('/');
  const first = parts[0] ?? '';
  const hasRegistry = parts.length > 1 && (first.includes('.') || first.includes(':'));
  const registry = hasRegistry ? first : defaultRegistry;
  const rest = hasRegistry ? parts.slice(1) : parts;
  const repository = rest.length === 1 ? `library/${rest[0]}` : rest.join('/');
  return { registry, repository, tag, ...(digest === undefined ? {} : { digest }) };
}

function splitNameTag(reference: string): [string, string | undefined] {
  const at = reference.lastIndexOf(':');
  if (at < 0) return [reference, undefined];
  if (reference.slice(at).includes('/')) return [reference, undefined];
  return [reference.slice(0, at), reference.slice(at + 1)];
}

const INDEX_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
];
const MANIFEST_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];
const ACCEPT = [...INDEX_TYPES, ...MANIFEST_TYPES].join(', ');

/**
 * Read a public OCI registry and build the Image Registry entry §8.1 wants,
 * by digest when `reference` names one (the only way `template:publish`
 * calls this) and by tag otherwise (kept for `template-publish.test.ts`'s
 * tag-only fixtures — a stub `fetchImpl` either way, never a real registry).
 *
 * Anonymous pull only, the same rule `smoke-image.ts`'s `readOciEntry`
 * follows: a `401` carrying `Www-Authenticate: Bearer realm=…` is answered
 * by asking that realm for a pull token; a registry that wants credentials
 * is refused out loud.
 */
export async function resolveOciEntry(
  reference: string,
  arch: string,
  options: { readonly defaultRegistry?: string; readonly fetchImpl?: typeof fetch } = {}
): Promise<{ ref: ParsedImageReference; entry: EntryContent }> {
  const call = options.fetchImpl ?? fetch;
  const ref = parseImageReference(reference, options.defaultRegistry ?? 'registry-1.docker.io');
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

  const what = ref.digest ?? ref.tag;
  const top = await get(what);
  if (!top.ok) {
    throw new Error(
      `${ref.registry}/${ref.repository}:${what} answered ${top.status} — this tool reads ` +
        'anonymously and holds no registry credentials.'
    );
  }
  const topType = top.headers.get('content-type') ?? '';
  const topBody: unknown = await top.json();

  let digest = ref.digest ?? top.headers.get('docker-content-digest') ?? '';
  let mediaType = topType;
  let size = Number(top.headers.get('content-length') ?? 0);
  let manifest = topBody;

  if (INDEX_TYPES.some((type) => topType.startsWith(type))) {
    const chosen = pickPlatform(topBody, arch);
    if (chosen === undefined) {
      throw new Error(
        `${reference} is a multi-platform index with no linux/${arch} manifest in it`
      );
    }
    const platform = await get(chosen.digest);
    if (!platform.ok) throw new Error(`its linux/${arch} manifest answered ${platform.status}`);
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
    throw new Error('that registry asked for credentials this tool does not hold');
  }
  const url = new URL(realm);
  if (service !== undefined) url.searchParams.set('service', service);
  if (scope !== undefined) url.searchParams.set('scope', scope);
  const answer = await call(url.toString());
  if (!answer.ok) throw new Error(`its token endpoint answered ${answer.status}`);
  const body = (await answer.json()) as { token?: unknown; access_token?: unknown };
  const found = typeof body.token === 'string' ? body.token : body.access_token;
  if (typeof found !== 'string') throw new Error('its token endpoint returned no token');
  return found;
}

/* -------------------------------------------------------------------------- */
/* template.json: what a publisher edits                                     */
/* -------------------------------------------------------------------------- */

export interface TemplateInputPort {
  readonly containerPort: number;
  readonly protocol: 'tcp' | 'udp';
}

export interface TemplateInputFile {
  /** The Template's `d` tag — its address's own name, e.g. `ssh-box`. */
  readonly name: string;
  /** Shown on a gallery card. Not read by `templates.ts` today (see header). */
  readonly title: string;
  readonly summary: string;
  readonly ports: readonly TemplateInputPort[];
  readonly envFixed: Readonly<Record<string, string>>;
  readonly envTenant: readonly string[];
  /** Documentary: every spawn needs a key regardless (`spawn-content.ts`'s
   *  `SSH_PUBLIC_KEY`), so this only ever needs to be `true` for this image. */
  readonly sshKeyRequired: boolean;
  readonly sshKeyNote?: string;
}

/**
 * Read `template.json`, or throw with the first thing wrong with it.
 *
 * Deliberately as strict as `templates.ts`'s own `readTemplateContent` — this
 * file becomes a signed, published claim about what an account is about to
 * run, and a malformed one is not a Template with a problem, it is not a
 * Template (the same rule `templates.ts` states for the read side).
 */
export function readTemplateInputFile(value: unknown): TemplateInputFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('template.json must be a JSON object');
  }
  const content = value as Record<string, unknown>;

  const name = asNonEmptyString(content.name);
  if (name === undefined || !/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
    throw new Error(
      '`name` must be a lowercase, hyphenated name (this becomes the Template\'s `d` tag)'
    );
  }
  const title = asNonEmptyString(content.title);
  if (title === undefined) throw new Error('`title` is required and must be a non-empty string');
  const summary = asNonEmptyString(content.summary);
  if (summary === undefined) {
    throw new Error('`summary` is required and must be a non-empty string');
  }

  const ports = readPorts(content.ports);
  const envFixed = readEnvFixed(content.env_fixed);
  const envTenant = readEnvTenant(content.env_tenant);

  const sshKey = content.ssh_key;
  if (typeof sshKey !== 'object' || sshKey === null || Array.isArray(sshKey)) {
    throw new Error('`ssh_key` is required and must be an object, e.g. `{ "required": true }`');
  }
  const sshKeyRecord = sshKey as Record<string, unknown>;
  if (sshKeyRecord.required !== true) {
    throw new Error(
      '`ssh_key.required` must be `true` — this Template\'s whole point is the tenant\'s key, ' +
        'and every spawn needs one regardless (spec §6.2), so this can never honestly be false'
    );
  }
  const sshKeyNote = asNonEmptyString(sshKeyRecord.note);

  return {
    name,
    title,
    summary,
    ports,
    envFixed,
    envTenant,
    sshKeyRequired: true,
    ...(sshKeyNote === undefined ? {} : { sshKeyNote }),
  };
}

function readPorts(value: unknown): TemplateInputPort[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('`ports` must be an array');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`ports[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const containerPort = record.container_port;
    const protocol = record.protocol;
    if (
      typeof containerPort !== 'number' ||
      !Number.isInteger(containerPort) ||
      containerPort < 1 ||
      containerPort > 65_535
    ) {
      throw new Error(`ports[${index}].container_port must be an integer in 1-65535`);
    }
    if (protocol !== 'tcp' && protocol !== 'udp') {
      throw new Error(`ports[${index}].protocol must be "tcp" or "udp"`);
    }
    return { containerPort, protocol };
  });
}

function readEnvFixed(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('`env_fixed` must be an object');
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, held] of Object.entries(record)) {
    if (typeof held !== 'string') throw new Error(`env_fixed.${key} must be a string`);
    out[key] = held;
  }
  return out;
}

function readEnvTenant(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('`env_tenant` must be an array');
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`env_tenant[${index}] must be a string`);
    return entry;
  });
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/* -------------------------------------------------------------------------- */
/* Planning: the two events, spending nothing                                */
/* -------------------------------------------------------------------------- */

export interface TemplatePublishPlan {
  readonly pubkey: string;
  readonly npub: string;
  readonly entryAddress: string;
  readonly entryEvent: EventTemplate;
  readonly templateAddress: string;
  readonly templateEvent: EventTemplate;
  readonly imageDigest: string;
  /** `--image`, verbatim, for the printed plan. */
  readonly image: string;
}

/**
 * Build the two unsigned events. Pure — no clock but the one passed in, no
 * network, no relay — so `--dry-run` and a real publish share this exact
 * function and can never print one thing and send another.
 */
export function planTemplatePublish(input: {
  readonly pubkey: string;
  readonly file: TemplateInputFile;
  readonly entry: EntryContent;
  readonly ref: ParsedImageReference;
  readonly image: string;
  readonly relay?: string | undefined;
  readonly now?: Date;
}): TemplatePublishPlan {
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const entryD = `${input.ref.repository.split('/').pop() ?? input.file.name}:${input.ref.tag}`;
  const entryAddress = `${REGISTRY_KIND}:${input.pubkey}:${entryD}`;

  const entryEvent: EventTemplate = {
    kind: REGISTRY_KIND,
    created_at: now,
    tags: [
      ['d', entryD],
      ['x', input.entry.digest.slice('sha256:'.length)],
      ['L', TOON_LABEL],
    ],
    content: JSON.stringify(input.entry),
  };

  const templateContent = {
    version: 1,
    image: {
      digest: input.entry.digest,
      registry_entry: {
        address: entryAddress,
        ...(input.relay === undefined ? {} : { relay: input.relay }),
      },
    },
    ports: input.file.ports.map((port) => ({
      container_port: port.containerPort,
      protocol: port.protocol,
    })),
    env_fixed: input.file.envFixed,
    env_tenant: input.file.envTenant,
    // Non-normative extras — see the file header.
    title: input.file.title,
    summary: input.file.summary,
    ssh_key: {
      required: input.file.sshKeyRequired,
      ...(input.file.sshKeyNote === undefined ? {} : { note: input.file.sshKeyNote }),
    },
  };
  const templateAddress = `${TEMPLATE_KIND}:${input.pubkey}:${input.file.name}`;
  const templateEvent: EventTemplate = {
    kind: TEMPLATE_KIND,
    created_at: now,
    tags: [
      ['d', input.file.name],
      ['L', TOON_LABEL],
    ],
    content: JSON.stringify(templateContent),
  };

  return {
    pubkey: input.pubkey,
    npub: npubEncode(input.pubkey),
    entryAddress,
    entryEvent,
    templateAddress,
    templateEvent,
    imageDigest: input.entry.digest,
    image: input.image,
  };
}

/* -------------------------------------------------------------------------- */
/* Publishing: signing and paying for the plan                               */
/* -------------------------------------------------------------------------- */

export interface TemplatePublishDeps {
  readonly sign: (template: EventTemplate) => Promise<NostrEvent>;
  /** The paid writer. In the CLI this is a `PaidRelayWriter` (relay-write.ts
   *  is the console's only writer — see main-template-publish.ts). */
  readonly writer: RelayWriter;
}

export interface TemplatePublishOutcome {
  readonly what: 'image-entry' | 'template';
  readonly address: string;
  readonly eventId: string;
  readonly cost?: string | undefined;
}

export interface TemplatePublishReport {
  readonly outcomes: readonly TemplatePublishOutcome[];
  /** Base units, summed from the claims. Never recomputed from a price. */
  readonly cost: string;
}

/**
 * Sign and pay for both events, image entry first — a Template whose entry
 * is not there yet resolves nothing were the two writes to land in the other
 * order and the second refused (ADR 0003: a refused write is still billed,
 * so this still means real money moved for an unresolved Template, which is
 * the ordering that fails safest).
 */
export async function publishTemplatePlan(
  plan: TemplatePublishPlan,
  deps: TemplatePublishDeps
): Promise<TemplatePublishReport> {
  const outcomes: TemplatePublishOutcome[] = [];
  let cost = 0n;

  const steps: readonly ['image-entry' | 'template', EventTemplate, string][] = [
    ['image-entry', plan.entryEvent, plan.entryAddress],
    ['template', plan.templateEvent, plan.templateAddress],
  ];

  for (const [what, template, address] of steps) {
    const event = await deps.sign(template);
    const receipt = await deps.writer.write({ event, what: `the ${what} at ${address}` });
    if (receipt.cost !== undefined) cost += safeBigInt(receipt.cost);
    outcomes.push({
      what,
      address,
      eventId: event.id,
      ...(receipt.cost === undefined ? {} : { cost: receipt.cost }),
    });
  }

  return { outcomes, cost: cost.toString() };
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/* -------------------------------------------------------------------------- */
/* The console's own action: publish AS the signed-in account (TOON_Network#138) */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/templates/publish(/preview)`'s body: the `template.json` content
 * a person read off disk (the TUI's job, not this console's — no secret is in
 * it), and the image it names, by digest.
 */
export interface ConsoleTemplatePublishRequest {
  readonly template: unknown;
  readonly image: string;
}

/** What `POST /api/templates/publish/preview` answers. Nothing is sent to buy this. */
export interface ConsoleTemplatePublishPreview {
  readonly entryKind: typeof REGISTRY_KIND;
  readonly entryAddress: string;
  readonly entryEvent: EventTemplate;
  readonly templateKind: typeof TEMPLATE_KIND;
  readonly templateAddress: string;
  readonly templateEvent: EventTemplate;
  readonly imageDigest: string;
  readonly title: string;
  readonly summary: string;
  /** The quoted price per write, the total for both writes, and `blockedBy`
   *  when nothing here could be paid for right now — straight off
   *  `RelayWriter.targets()`, never recomputed (#82). */
  readonly targets: RelayWriteTargets;
}

/** What `POST /api/templates/publish` answers on success. */
export interface ConsoleTemplatePublishResult extends TemplatePublishReport {
  readonly templateAddress: string;
}

export class ConsoleTemplatePublishError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ConsoleTemplatePublishError';
    this.code = code;
    this.status = status;
  }
}

export interface ConsoleTemplatePublisherDeps {
  /** The session's signer, exactly as `ChainSeedStore` is handed one —
   *  `undefined` when nobody is signed in. */
  readonly signer: () => AccountSigning | undefined;
  /** The console's one writer (`relay-write.ts`). A thunk for the same
   *  reason `chain-seed.ts`'s is: whichever of the two is built second is
   *  the one that exists by the time either is used. */
  readonly writer: () => RelayWriter;
  /** Injected in tests; the default reads a real public registry. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly arch?: string | undefined;
}

/**
 * Preview and publish a Template as the signed-in account, paying from its
 * own relay channel — the one thing `main-template-publish.ts` cannot do for
 * an account whose key was generated inside the console (TOON_Network#138).
 *
 * The shape is `ChainSeedStore.publish`'s: planning spends nothing and is the
 * exact same `planTemplatePublish` a real publish signs, so a preview and a
 * publish can never disagree about what would be sent; signing goes through
 * the session's `ConsoleSigner` and never a raw key (ADR 0020); and paying
 * goes through `relay-write.ts`, the console's only writer, which is what
 * turns a `RelayWriteError` — a refused or unpayable write — into a clear
 * refusal rather than a silent 500.
 */
export class ConsoleTemplatePublisher {
  readonly #deps: ConsoleTemplatePublisherDeps;

  constructor(deps: ConsoleTemplatePublisherDeps) {
    this.#deps = deps;
  }

  async preview(request: ConsoleTemplatePublishRequest): Promise<ConsoleTemplatePublishPreview> {
    const { plan, file } = await this.#plan(request);
    const targets = await this.#deps.writer().targets();
    return {
      entryKind: REGISTRY_KIND,
      entryAddress: plan.entryAddress,
      entryEvent: plan.entryEvent,
      templateKind: TEMPLATE_KIND,
      templateAddress: plan.templateAddress,
      templateEvent: plan.templateEvent,
      imageDigest: plan.imageDigest,
      title: file.title,
      summary: file.summary,
      targets,
    };
  }

  async publish(request: ConsoleTemplatePublishRequest): Promise<ConsoleTemplatePublishResult> {
    const signer = this.#signer();
    const { plan } = await this.#plan(request);
    const report = await publishTemplatePlan(plan, {
      sign: (template) => signer.sign(template),
      writer: this.#deps.writer(),
    });
    return { ...report, templateAddress: plan.templateAddress };
  }

  async #plan(
    request: ConsoleTemplatePublishRequest
  ): Promise<{ readonly plan: TemplatePublishPlan; readonly file: TemplateInputFile }> {
    const signer = this.#signer();

    let file: TemplateInputFile;
    try {
      file = readTemplateInputFile(request.template);
    } catch (error) {
      throw new ConsoleTemplatePublishError('invalid_template', messageOf(error), 400);
    }

    let resolved: { ref: ParsedImageReference; entry: EntryContent };
    try {
      resolved = await resolveOciEntry(request.image, this.#deps.arch ?? 'amd64', {
        ...(this.#deps.fetchImpl === undefined ? {} : { fetchImpl: this.#deps.fetchImpl }),
      });
    } catch (error) {
      throw new ConsoleTemplatePublishError('image_unresolved', messageOf(error), 400);
    }

    const plan = planTemplatePublish({
      pubkey: signer.pubkey,
      file,
      entry: resolved.entry,
      ref: resolved.ref,
      image: request.image,
    });
    return { plan, file };
  }

  #signer(): AccountSigning {
    const signer = this.#deps.signer();
    if (signer === undefined) {
      throw new ConsoleTemplatePublishError(
        'not_signed_in',
        'Sign in before publishing a Template: it is published as the signed-in account and ' +
          'paid from its own relay channel, the same way the Chain Seed is.',
        409
      );
    }
    return signer;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
