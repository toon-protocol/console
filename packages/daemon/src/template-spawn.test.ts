import { describe, expect, it } from 'vitest';

import { fakeRelays } from './directory.testkit.js';
import type { NostrEvent } from './nostr.js';
import { DEVNET } from './profiles.js';
import { queryRelays } from './relay-pool.js';
import {
  buildSpawnContent,
  canonicalSpawnContent,
  HEX_32,
  NO_SSH_PLACEHOLDER_KEY,
  type SpawnContent,
} from './spawn-content.js';
import {
  expandTemplate,
  listingClearsFloor,
  TemplateExpansionError,
  type TemplateSettings,
} from './template-spawn.js';
import { readTemplates, type TemplateGalleryView, type TemplateView } from './templates.js';
import {
  fakePublisher,
  FIXTURE_DIGEST,
  imageEntryEvent,
  specEvent,
  specFixture,
  templateEvent,
} from './templates.testkit.js';

/**
 * Expanding a Template (TOON_Network#94, spec §8.3).
 *
 * The first test is the ticket's third acceptance criterion and the reason
 * this module exists: an expanded Template and the manual spawn of the same
 * thing are the SAME request. It is written as an equality rather than as a
 * list of assertions on purpose — a field added to a spawn later has to appear
 * on both sides or this fails, which is what "the same result" has to mean six
 * months from now.
 */

const RELAY = 'wss://relay.test';
const publisher = fakePublisher('template-publisher');

const SSH_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxvbmdlbm91Z2hmb3JhdGVzdGtleQ tenant@fixture';
const WORKLOAD_ID = 'd2'.repeat(32);

async function readOne(events: readonly NostrEvent[]): Promise<TemplateView> {
  const { dial } = fakeRelays([{ url: RELAY, events: [...events] }]);
  const result = (await readTemplates({
    profile: { ...DEVNET, relayUrl: RELAY },
    timeoutMs: 200,
    query: (query) => queryRelays({ ...query, dial }),
  })) as TemplateGalleryView;
  const template = result.templates[0];
  if (template === undefined) throw new Error('no Template was read');
  return template;
}

function siteTemplate(): Promise<TemplateView> {
  return readOne([
    templateEvent(publisher, {
      name: 'static-site',
      ports: [{ containerPort: 8080 }],
      envFixed: { MODE: 'production' },
      envTenant: ['SITE_TITLE'],
    }),
    imageEntryEvent(publisher),
  ]);
}

function noSshTemplate(): Promise<TemplateView> {
  return readOne([
    templateEvent(publisher, {
      name: 'smoke-http',
      ports: [{ containerPort: 80 }],
      sshOffered: false,
    }),
    imageEntryEvent(publisher),
  ]);
}

const settings: TemplateSettings = {
  env: { SITE_TITLE: 'a small site' },
  sshPublicKey: SSH_KEY,
  workloadId: WORKLOAD_ID,
  volumeGb: 2,
};

describe('expandTemplate', () => {
  it('produces exactly the spawn a manual one would', async () => {
    const template = await siteTemplate();
    const expanded = expandTemplate(template, settings);

    // The manual path (TOON_Network#92): the same values, typed into a blank
    // form by somebody who read the Template's card and copied it.
    const manual: SpawnContent = buildSpawnContent({
      workloadId: WORKLOAD_ID,
      image: {
        digest: FIXTURE_DIGEST,
        registry_entry: { address: `30434:${publisher.pubkey}:web:1.0`, relay: 'wss://relay.toon.test' },
      },
      env: { MODE: 'production', SITE_TITLE: 'a small site' },
      ports: [{ container_port: 8080, protocol: 'tcp' }],
      volumeGb: 2,
      sshPublicKey: SSH_KEY,
      template: `30436:${publisher.pubkey}:static-site`,
    });

    expect(expanded.spawn).toEqual(manual);
    expect(canonicalSpawnContent(expanded.spawn)).toBe(canonicalSpawnContent(manual));
  });

  it('carries the Template’s address as the informational `template` field', async () => {
    const template = await siteTemplate();
    const { spawn } = expandTemplate(template, settings);
    expect(spawn.template).toBe(`30436:${publisher.pubkey}:static-site`);
  });

  it('chooses a workload id when none is given, and a different one each time', async () => {
    const template = await siteTemplate();
    const first = expandTemplate(template, { sshPublicKey: SSH_KEY }).spawn.workload_id;
    const second = expandTemplate(template, { sshPublicKey: SSH_KEY }).spawn.workload_id;
    expect(first).toMatch(HEX_32);
    expect(second).not.toBe(first);
  });

  it('leaves `volume_gb` and `standby_set` out rather than sending empty ones', async () => {
    const template = await siteTemplate();
    const { spawn } = expandTemplate(template, { sshPublicKey: SSH_KEY });
    expect('volume_gb' in spawn).toBe(false);
    expect('standby_set' in spawn).toBe(false);
  });

  it('refuses a setting the Template does not mark tenant-settable', async () => {
    const template = await siteTemplate();
    expect(() =>
      expandTemplate(template, { ...settings, env: { ADMIN_TOKEN: 'let me in' } })
    ).toThrow(/does not list `ADMIN_TOKEN`/u);
  });

  it('refuses to overwrite a setting the Template fixed', async () => {
    const template = await siteTemplate();
    try {
      expandTemplate(template, { ...settings, env: { MODE: 'debug' } });
      throw new Error('it was allowed');
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateExpansionError);
      expect((error as TemplateExpansionError).code).toBe('not_tenant_settable');
      expect((error as TemplateExpansionError).message).toMatch(/fixes `MODE`/u);
    }
  });

  it('keeps the fixed value when a name is both fixed and listed as settable', async () => {
    const template = await readOne([
      templateEvent(publisher, {
        name: 'confused',
        envFixed: { MODE: 'production' },
        envTenant: ['MODE'],
      }),
      imageEntryEvent(publisher),
    ]);
    expect(expandTemplate(template, { sshPublicKey: SSH_KEY }).spawn.env).toEqual({
      MODE: 'production',
    });
    expect(() =>
      expandTemplate(template, { sshPublicKey: SSH_KEY, env: { MODE: 'debug' } })
    ).toThrow(/fixes `MODE`/u);
  });

  it('will not expand a Template whose image cannot be resolved', async () => {
    // The entry it names is on no relay, so the gallery marks it unavailable —
    // and asking for it anyway is refused rather than sold.
    const template = await readOne([templateEvent(publisher, { name: 'static-site' })]);
    expect(template.availability.state).toBe('unavailable');
    try {
      expandTemplate(template, settings);
      throw new Error('it was expanded');
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateExpansionError);
      expect((error as TemplateExpansionError).code).toBe('image_unresolved');
    }
  });

  it('refuses something that is not an SSH public key', async () => {
    const template = await siteTemplate();
    expect(() => expandTemplate(template, { ...settings, sshPublicKey: 'hunter2' })).toThrow(
      /SSH public key/u
    );
  });

  it('refuses a standby set that repeats a provider', async () => {
    const template = await siteTemplate();
    const provider = 'a'.repeat(64);
    expect(() =>
      expandTemplate(template, { ...settings, standbySet: [provider, provider] })
    ).toThrow(/each provider once/u);
  });

  it('says which tenant settings were left unset, without refusing', async () => {
    const template = await siteTemplate();
    const expanded = expandTemplate(template, { sshPublicKey: SSH_KEY });
    expect(expanded.warnings.join(' ')).toMatch(/SITE_TITLE.*left unset/su);
    expect(expanded.spawn.env).toEqual({ MODE: 'production' });
  });

  it('says so when a Template with a data path is spawned without a volume', async () => {
    const template = await readOne([
      templateEvent(publisher, { name: 'stateful', dataPath: '/data' }),
      imageEntryEvent(publisher),
    ]);
    expect(expandTemplate(template, { sshPublicKey: SSH_KEY }).warnings.join(' ')).toMatch(
      /ends with the lease/u
    );
  });
});

/**
 * A Template that does not offer SSH (TOON_Network#138).
 *
 * §6.2 still requires `ssh_public_key` on the wire — the provider forwards
 * `access.ssh_port` to the container's port 22 whether or not anything is
 * there — so the placeholder has to be sent regardless. What must NOT happen
 * is the tenant's real key leaving for a lock this Template says does not
 * exist.
 */
describe('expandTemplate, for a Template that does not offer SSH', () => {
  it('sends the placeholder key, never a real one, however the caller filled the field in', async () => {
    const template = await noSshTemplate();
    const withoutKey = expandTemplate(template, { sshPublicKey: '' });
    expect(withoutKey.spawn.ssh_public_key).toBe(NO_SSH_PLACEHOLDER_KEY);

    const withKey = expandTemplate(template, { sshPublicKey: SSH_KEY });
    expect(withKey.spawn.ssh_public_key).toBe(NO_SSH_PLACEHOLDER_KEY);
  });

  it('echoes `sshOffered: false` on the expansion', async () => {
    const template = await noSshTemplate();
    expect(expandTemplate(template, { sshPublicKey: '' }).sshOffered).toBe(false);
  });

  it('does not refuse an empty `sshPublicKey`, unlike a Template that offers SSH', async () => {
    const offers = await siteTemplate();
    expect(() => expandTemplate(offers, { sshPublicKey: '' })).toThrow(/SSH public key/u);

    const offersNot = await noSshTemplate();
    expect(() => expandTemplate(offersNot, { sshPublicKey: '' })).not.toThrow();
  });
});

describe('the image a Template expands to', () => {
  it('is §6.2’s registry-entry form, exactly as the spec’s spawn carries it', async () => {
    // Both sides come from the same Image Registry entry: the spec's Template
    // fixture and the spec's spawn fixture name the same image, and the
    // expansion has to land on the same object — address, colon in the `d`,
    // relay hint and all.
    const template = await readOne([
      specEvent('registry.template'),
      specEvent('registry.image_entry'),
    ]);
    const expanded = expandTemplate(template, { sshPublicKey: SSH_KEY });
    const spawn = specFixture('spawn_image.registry_entry') as {
      spawn_content: { image: unknown };
    };
    expect(expanded.spawn.image).toEqual(spawn.spawn_content.image);
  });
});

describe('listingClearsFloor', () => {
  const floor = { cpuMillicores: 500, memoryMb: 256, storageGb: 4 };

  it('is true when a tier has at least what the Template asks for', () => {
    expect(
      listingClearsFloor(
        { resources: { cpuMillicores: 500, memoryMb: 512, storageGb: 5 } },
        floor
      )
    ).toBe(true);
  });

  it('is false when it has less', () => {
    expect(
      listingClearsFloor(
        { resources: { cpuMillicores: 250, memoryMb: 512, storageGb: 5 } },
        floor
      )
    ).toBe(false);
  });

  it('is true for a Template that names no floor at all', () => {
    expect(
      listingClearsFloor(
        { resources: { cpuMillicores: 1, memoryMb: 1, storageGb: 1 } },
        undefined
      )
    ).toBe(true);
  });
});
