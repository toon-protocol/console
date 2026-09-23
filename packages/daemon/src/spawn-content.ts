import { randomBytes } from 'node:crypto';

/**
 * A spawn's content (spec §6.2), in exactly the shape that goes on the wire.
 *
 * This file exists so that there is ONE of these. A spawn built by hand from a
 * Listing (TOON_Network#92) and a spawn expanded from a Template (#94) are the
 * same request with different provenance, and the acceptance criterion that
 * says so — "spawning from a Template produces the same result as the
 * equivalent manual spawn" — is only checkable if both paths end at one
 * builder. Two builders that agree today would be two builders tomorrow.
 *
 * The field names are the WIRE's, snake_case and all, rather than the console's
 * camelCase. Everything else in the daemon translates at its edges; this type
 * deliberately does not, because it IS the edge: the value of `request.content`
 * in §6.1's Lease Request, handed to the connector unchanged. A rename here
 * would be a protocol change wearing a style guide's clothes.
 *
 * Nothing in this file pays, seals or sends. Building the content and buying
 * the lease are different jobs, and the second one is #92's.
 */

export interface SpawnPort {
  readonly container_port: number;
  readonly protocol: 'tcp' | 'udp';
}

/** §6.2's registry-entry form: where an entry lists a blob's real sources. */
export interface SpawnRegistryEntry {
  /** `30434:<pubkey>:<name>:<tag>` — the `d` keeps its own colon (§6.2). */
  readonly address: string;
  /** A hint for FINDING the entry. Never an authority: the signer is (§6.2). */
  readonly relay?: string;
}

/**
 * The three forms of §6.2's `image`, as one type.
 *
 * `reference` and `registry_entry` MUST NOT both be present, and a Template
 * never names the upstream form at all (§8.3): an image a Template names is
 * named by content address. The type keeps all three so that #92's manual
 * spawn, which MAY name an upstream image, shares this builder.
 */
export interface SpawnImage {
  readonly digest: string;
  readonly reference?: string;
  readonly registry_entry?: SpawnRegistryEntry;
}

export interface SpawnContent {
  readonly workload_id: string;
  readonly image: SpawnImage;
  readonly env: Readonly<Record<string, string>>;
  readonly ports: readonly SpawnPort[];
  readonly volume_gb?: number;
  readonly ssh_public_key: string;
  readonly entrypoint?: readonly string[];
  readonly args?: readonly string[];
  readonly standby_set?: readonly string[];
  /** Informational `30436:<pubkey>:<d>` the values came from (§6.2, §8.3). */
  readonly template?: string;
}

export interface SpawnContentInput {
  /** Omitted means "choose one": 32 random bytes, as §6.2 requires. */
  readonly workloadId?: string | undefined;
  readonly image: SpawnImage;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly ports?: readonly SpawnPort[] | undefined;
  readonly volumeGb?: number | undefined;
  readonly sshPublicKey: string;
  readonly entrypoint?: readonly string[] | undefined;
  readonly args?: readonly string[] | undefined;
  readonly standbySet?: readonly string[] | undefined;
  readonly template?: string | undefined;
}

/** 32 bytes of hex: `workload_id`, `request_id` and a digest's hex half. */
export const HEX_32 = /^[0-9a-f]{64}$/u;
/** §6.2: `sha256:` and exactly 64 LOWERCASE hex characters. Nothing else. */
export const DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * An environment variable's name, as a shell and an OCI runtime accept one.
 *
 * Checked because a Template's `env_fixed` keys and `env_tenant` names come
 * from a publisher the console has never met, and `env` goes into a container
 * this account pays for. A name with an `=` or a newline in it is not a
 * variable, it is an attempt at a second one.
 */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * An OpenSSH public key line, roughly: a type, a base64 body, an optional
 * comment. Rough on purpose — this rejects a private key pasted by mistake,
 * a passphrase, and an empty box, which is what a person actually does wrong.
 * The provider is the authority on what it will install (§9).
 */
export const SSH_PUBLIC_KEY =
  /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-[a-z0-9-]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( .*)?$/u;

/** A fresh `workload_id`: 32 bytes the tenant chooses at random (§6.2). */
export function newWorkloadId(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The one place a spawn's content is assembled.
 *
 * Absent beats empty, everywhere: a spawn with no volume omits `volume_gb`
 * rather than sending `0`, and one with no standbys omits `standby_set` rather
 * than sending `[]`. §6.2 branches on PRESENCE — a `standby_set` present at
 * all makes the request a Standby Set member's and changes which route it must
 * arrive on — so an empty array is not a harmless way to say "none".
 */
export function buildSpawnContent(input: SpawnContentInput): SpawnContent {
  return {
    workload_id: input.workloadId ?? newWorkloadId(),
    image: input.image,
    env: { ...(input.env ?? {}) },
    ports: [...(input.ports ?? [])],
    ...(input.volumeGb === undefined ? {} : { volume_gb: input.volumeGb }),
    ssh_public_key: input.sshPublicKey,
    ...(input.entrypoint === undefined ? {} : { entrypoint: [...input.entrypoint] }),
    ...(input.args === undefined ? {} : { args: [...input.args] }),
    ...(input.standbySet === undefined ? {} : { standby_set: [...input.standbySet] }),
    ...(input.template === undefined ? {} : { template: input.template }),
  };
}

/**
 * One spawn's content as one string, with every object's keys in sorted order.
 *
 * A spawn is not signed (ADR 0016), so key order means nothing on the wire and
 * two contents that differ only in it are the same request. This exists for
 * the tests and for the UI's preview: "the same spawn a manual one would
 * produce" has to be decidable by something stricter than reading two JSON
 * blobs side by side, and deep equality alone would not catch a stray
 * `undefined` that `JSON.stringify` drops on the way out.
 */
export function canonicalSpawnContent(content: SpawnContent): string {
  return JSON.stringify(sortKeys(content));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, held]) => held !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, held]) => [key, sortKeys(held)]));
}
