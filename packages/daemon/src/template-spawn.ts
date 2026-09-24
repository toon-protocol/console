import {
  buildSpawnContent,
  ENV_NAME,
  HEX_32,
  NO_SSH_PLACEHOLDER_KEY,
  SSH_PUBLIC_KEY,
  type SpawnContent,
  type SpawnImage,
  type SpawnPort,
} from './spawn-content.js';
import type { ListingView } from './directory.js';
import type { TemplateResources, TemplateView } from './templates.js';

/**
 * Expanding a Template into a spawn — the tenant's job, in v1 (spec §8.3).
 *
 * "Who expands it: in v1 the TENANT expands a Template into a spawn. The
 * provider never reads Templates, and `template` in a spawn is informational."
 * That sentence is this file. Nothing here talks to a provider, and the
 * expansion is complete before anybody is asked for anything: what comes out
 * is the §6.2 content a manual spawn would have carried, with the Template's
 * address alongside it as a note about where the values came from.
 *
 * The property this exists to guarantee is that the two paths END UP THE SAME.
 * A Template is a convenience, not a second protocol — an account that expands
 * `static-site` and an account that types the same digest, ports and
 * environment into a blank form must produce the same request, or "spawn from
 * a Template" would quietly mean something else. Both paths run through
 * `buildSpawnContent`, and `template-spawn.test.ts` is the test that compares
 * them field by field.
 *
 * WHAT A TENANT MAY CHANGE, and nothing else:
 *
 * - the environment variables the Template lists in `env_tenant`;
 * - its own SSH public key, which no Template can know;
 * - whether to ask for a volume, and how big;
 * - the workload id, which is the tenant's random choice (§6.2);
 * - the Standby Set, which belongs to the lease and not to the Template (§7).
 *
 * Everything else — the image, the ports, the fixed environment — is the
 * publisher's, and an attempt to set it is REFUSED rather than ignored.
 * Refusing is the point of the acceptance criterion: a console that silently
 * dropped an edit would show a person one spawn and send another.
 *
 * `entrypoint` and `args` are deliberately not settable from a Template either,
 * though §6.2 has fields for them. A Template says what it runs; overriding its
 * entrypoint would make the gallery's description of it untrue while keeping
 * its name, its publisher and its content address on screen. A person who
 * wants another command wants the manual spawn (#92), where the image is
 * theirs to describe.
 */

export class TemplateExpansionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'TemplateExpansionError';
    this.code = code;
    this.status = status;
  }
}

export interface TemplateSettings {
  /** Values for names the Template lists in `env_tenant`, and only those. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /**
   * The tenant's real key. Required when `template.sshOffered` is true, and
   * IGNORED — never sent — when it is false: `expandTemplate` substitutes
   * `NO_SSH_PLACEHOLDER_KEY` instead, so leaving this blank there is correct,
   * not merely tolerated.
   */
  readonly sshPublicKey: string;
  readonly volumeGb?: number | undefined;
  /** 32 bytes of hex. Omitted means the daemon chooses one at random (§6.2). */
  readonly workloadId?: string | undefined;
  /** Provider pubkeys, primary first (§7). Absent is a standalone lease. */
  readonly standbySet?: readonly string[] | undefined;
}

export interface ExpandedTemplate {
  /** `30436:<pubkey>:<d>`, the Template these values came from. */
  readonly template: string;
  /** Exactly what a manual spawn of the same thing would carry (§6.2). */
  readonly spawn: SpawnContent;
  /**
   * Whether `spawn.ssh_public_key` is the tenant's own key — `template.sshOffered`,
   * echoed back so a caller does not have to re-fetch the Template to know why
   * the field it typed did or did not end up on the wire.
   */
  readonly sshOffered: boolean;
  /** Worth saying, and not worth refusing over. */
  readonly warnings: readonly string[];
}

/**
 * Expand `template` with `settings`, or refuse and say why.
 *
 * The first refusal is the one the ticket cares most about: a Template whose
 * image could not be resolved is not expanded at all. It is shown as
 * unavailable in the gallery, and if a window asks for it anyway — a stale tab,
 * a scripted caller — the daemon says no rather than selling an account a lease
 * for an image no provider will find.
 */
export function expandTemplate(
  template: TemplateView,
  settings: TemplateSettings
): ExpandedTemplate {
  if (template.availability.state !== 'available') {
    throw new TemplateExpansionError(
      'image_unresolved',
      `${template.name} cannot be spawned: ${template.availability.reason}`
    );
  }

  const typedKey = settings.sshPublicKey.trim();
  let sshPublicKey: string;
  if (template.sshOffered) {
    if (!SSH_PUBLIC_KEY.test(typedKey)) {
      throw new TemplateExpansionError(
        'invalid_ssh_key',
        'A spawn needs the tenant’s SSH public key — one line, as `~/.ssh/id_ed25519.pub` ' +
          'holds it. No password is ever issued for a workload (§6.2, §9).'
      );
    }
    sshPublicKey = typedKey;
  } else {
    // §6.2 still requires the field on the wire (the provider always forwards
    // `access.ssh_port` to the container's port 22, sshd or not — TOON_Network#138),
    // but this Template says plainly it has none, so the tenant's real key
    // never leaves this machine for a lock nothing here can open.
    sshPublicKey = NO_SSH_PLACEHOLDER_KEY;
  }

  const workloadId = settings.workloadId?.trim();
  if (workloadId !== undefined && !HEX_32.test(workloadId)) {
    throw new TemplateExpansionError(
      'invalid_workload_id',
      'A `workloadId` is 32 bytes as 64 lowercase hex characters, or left out to have one ' +
        'chosen at random (§6.2).'
    );
  }

  const env = tenantEnv(template, settings.env ?? {});
  const warnings = [...expansionWarnings(template, settings)];

  return {
    template: template.address,
    spawn: buildSpawnContent({
      ...(workloadId === undefined ? {} : { workloadId }),
      image: spawnImage(template),
      env,
      ports: spawnPorts(template),
      ...(settings.volumeGb === undefined ? {} : { volumeGb: volumeGb(settings.volumeGb) }),
      sshPublicKey,
      ...(settings.standbySet === undefined
        ? {}
        : { standbySet: standbySet(settings.standbySet) }),
      // Informational, and carried anyway: a provider parses it so it cannot
      // arrive as an unknown field, and never acts on it (§6.2, §8.3).
      template: template.address,
    }),
    sshOffered: template.sshOffered,
    warnings,
  };
}

/**
 * The image, unchanged from the Template.
 *
 * This is the field that must not drift. A Template names an image by content
 * address (§8.3) and the spawn carries §6.2's registry-entry or digest-alone
 * form of the same thing — the SAME digest, the SAME entry address, the SAME
 * relay hint. Re-deriving any of it from what the console happened to read
 * would let a relay's answer change what an account spawns.
 */
function spawnImage(template: TemplateView): SpawnImage {
  const ref = template.image.registryEntry;
  if (ref === undefined) return { digest: template.image.digest };
  return {
    digest: template.image.digest,
    registry_entry: {
      address: ref.address,
      ...(ref.relay === undefined ? {} : { relay: ref.relay }),
    },
  };
}

function spawnPorts(template: TemplateView): SpawnPort[] {
  return template.ports.map((port) => ({
    container_port: port.containerPort,
    protocol: port.protocol,
  }));
}

/**
 * `env_fixed` plus what the tenant set, and a refusal for anything else.
 *
 * A name in both lists is fixed (see `templates.ts`'s warning): the pin wins,
 * and trying to set it is refused with the same message as any other setting
 * that is not the tenant's. That is the honest answer — the value the publisher
 * pinned is the one that will be used either way, and pretending the edit
 * landed would be the lie.
 */
function tenantEnv(
  template: TemplateView,
  wanted: Readonly<Record<string, string>>
): Record<string, string> {
  const settable = template.envTenant.filter((name) => !(name in template.envFixed));
  const env: Record<string, string> = { ...template.envFixed };

  for (const [name, value] of Object.entries(wanted)) {
    if (!ENV_NAME.test(name)) {
      throw new TemplateExpansionError(
        'invalid_env_name',
        `\`${name.slice(0, 64)}\` is not an environment variable name.`
      );
    }
    if (typeof value !== 'string') {
      throw new TemplateExpansionError('invalid_env_value', `\`${name}\` must be a string.`);
    }
    if (!settable.includes(name)) {
      throw new TemplateExpansionError(
        'not_tenant_settable',
        name in template.envFixed
          ? `${template.name} fixes \`${name}\`, so it cannot be set here (§8.3).`
          : `${template.name} does not list \`${name}\` as tenant-settable, and only the names ` +
              `it lists may be set${settable.length === 0 ? '' : `: ${settable.join(', ')}`} (§8.3).`
      );
    }
    env[name] = value;
  }

  return env;
}

function volumeGb(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TemplateExpansionError(
      'invalid_volume',
      '`volumeGb` is a whole number of gigabytes, and a lease with no volume simply leaves it ' +
        'out (§6.2).'
    );
  }
  return value;
}

function standbySet(members: readonly string[]): string[] {
  if (members.length === 0) {
    throw new TemplateExpansionError(
      'invalid_standby_set',
      'A `standbySet` present at all makes this a Standby Set member’s spawn (§6.2 step 3). ' +
        'Leave it out for a standalone lease.'
    );
  }
  for (const member of members) {
    if (!HEX_32.test(member)) {
      throw new TemplateExpansionError(
        'invalid_standby_set',
        'A `standbySet` lists provider public keys, primary first (§7).'
      );
    }
  }
  if (new Set(members).size !== members.length) {
    // §6.2 step 3: "a list that repeats a provider gives it two positions and
    // so two roles" — which is `invalid_request` at the provider, and is worth
    // catching before it is paid for.
    throw new TemplateExpansionError(
      'invalid_standby_set',
      'A `standbySet` lists each provider once: a repeat would give one provider two roles ' +
        '(§6.2 step 3).'
    );
  }
  return [...members];
}

function expansionWarnings(template: TemplateView, settings: TemplateSettings): string[] {
  const warnings: string[] = [];
  const settable = template.envTenant.filter((name) => !(name in template.envFixed));
  const unset = settable.filter((name) => !(name in (settings.env ?? {})));
  if (unset.length > 0) {
    // Not a refusal: §8.3 lists the names a tenant MAY set, not the ones it
    // must. A variable left out simply is not in the container's environment,
    // which is a thing a person may well mean.
    warnings.push(
      `${unset.join(', ')} ${unset.length === 1 ? 'is' : 'are'} tenant-settable and left unset, ` +
        'so the workload starts without it.'
    );
  }
  if (template.dataPath !== undefined && settings.volumeGb === undefined) {
    warnings.push(
      `${template.name} keeps its data at ${template.dataPath}. With no volume, whatever it ` +
        'writes there ends with the lease.'
    );
  }
  if (template.dataPath === undefined && settings.volumeGb !== undefined) {
    warnings.push(
      `${template.name} names no data path, so where the provider mounts this volume is its ` +
        'own choice (§6.2 has no field for the path).'
    );
  }
  return warnings;
}

/**
 * Whether a Listing clears a Template's floor (§8.3).
 *
 * `min_resources` is "read as a FLOOR for choosing a Listing rather than as a
 * rule on any provider" — so this answers a question the console asks itself
 * while a person picks a tier, and it never refuses a spawn. A publisher's
 * idea of what its image needs is a suggestion, and an account that knows
 * better is allowed to be right.
 */
export function listingClearsFloor(
  listing: Pick<ListingView, 'resources'>,
  floor: TemplateResources | undefined
): boolean {
  if (floor === undefined) return true;
  const { resources } = listing;
  if (resources.cpuMillicores < floor.cpuMillicores) return false;
  if (resources.memoryMb < floor.memoryMb) return false;
  if (resources.storageGb < floor.storageGb) return false;
  if (floor.gpu !== undefined && resources.gpu !== floor.gpu) return false;
  return true;
}

/**
 * The seam TOON_Network#92 fills: sending the spawn and paying for it.
 *
 * Everything above produces a spawn's content. Turning that content into a
 * lease is a different job and a paid one — it needs a Root Secret, the
 * Continuation Token derived from it (§6.1), a payment channel with the
 * provider's connector, the sealed envelope, and the Lease Vault record that
 * must be written BEFORE the spawn is sent (#92's own acceptance criteria).
 * None of that belongs to the gallery, and none of it is duplicated here.
 *
 * So this is the whole of the contract between the two tickets: #94 hands over
 * a §6.2 content and the listing it is to be bought on, and #92 does the rest.
 * Until it is wired, `POST /api/templates/spawn` answers `501` and hands back
 * the expansion, which is exactly what a caller needs to see that the two
 * halves fit.
 */
export interface TemplateSpawnRequest {
  /** `30436:<pubkey>:<d>`, for the record the spawn will carry anyway. */
  readonly template: string;
  /** The provider to buy from: the pubkey of the chosen Listing's author. */
  readonly provider: string;
  /** `30432:<pubkey>:<name>` — the tier, and the route it generates (§5). */
  readonly listing: string;
  /** The listing version a spawn is bought at (§4.2, ADR 0009). */
  readonly listingVersion: number;
  /** Already expanded. Nothing in it is reinterpreted downstream. */
  readonly content: SpawnContent;
  /** #92's "local only": the Root Secret is then never published (ADR 0021). */
  readonly localOnly?: boolean;
}

/** What #92 implements, and what `main.ts` will pass in once it exists. */
export type TemplateSpawnPort = (request: TemplateSpawnRequest) => Promise<unknown>;
