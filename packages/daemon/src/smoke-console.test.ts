import { describe, expect, it } from 'vitest';

import { parseArgs } from './main-smoke-console.js';
import { SANDBOX } from './profiles.js';
import {
  SmokeRun,
  STAGES,
  must,
  planConditional,
  present,
  summarize,
  type NetworkFacts,
} from './smoke-console.js';
import { entryFromManifest, parseImageRef, pickPlatform } from './smoke-image.js';

/**
 * What CI runs of `smoke-console` (TOON_Network#101).
 *
 * The smoke itself does not run here and says why in `main-smoke-console.ts`:
 * it spends on a live network, its sandbox is a docker stack built from four
 * sibling checkouts, and devnet is shared and single-threaded. What DOES run on
 * every push is the judgement — which stages a network can carry, what counts
 * as proved, and what the summary is obliged to say about everything else.
 *
 * That is the half worth testing here, because it is the half that could
 * silently turn a skip into a pass.
 */

const NOTHING: NetworkFacts = {
  clearnetProviders: 1,
  standbySellers: 1,
  hiddenProviders: 0,
  gatewayConnectorUrl: '',
  gatewayHandoverRoute: false,
  socksProxy: false,
};

describe('what a network can be asked to prove', () => {
  it('runs a Standby Set only where two providers sell one', () => {
    expect(planConditional({ ...NOTHING, standbySellers: 2 })['standby-set'].run).toBe(true);
    const one = planConditional({ ...NOTHING, standbySellers: 1 })['standby-set'];
    expect(one.run).toBe(false);
    expect(one.reason).toContain('1 selling a tier');
  });

  it('runs the Hidden Provider stage only where one is published', () => {
    expect(planConditional({ ...NOTHING, hiddenProviders: 2 }).hidden.run).toBe(true);
    expect(planConditional(NOTHING).hidden.reason).toContain('`hidden`');
  });

  it('tells a profile with no gateway from a gateway that is not running', () => {
    const none = planConditional(NOTHING).gateway;
    expect(none.run).toBe(false);
    expect(none.reason).toContain('names no Workload Gateway connector');

    const down = planConditional({
      ...NOTHING,
      gatewayConnectorUrl: 'http://localhost:3260/ilp',
      gatewayHandoverRoute: false,
    }).gateway;
    expect(down.run).toBe(false);
    // The distinction is the whole point: one is a profile, the other is a
    // machine that is not up, and they are fixed differently.
    expect(down.reason).toContain('published no');
    expect(down.reason).toContain('make up-gateway');

    expect(
      planConditional({
        ...NOTHING,
        gatewayConnectorUrl: 'http://localhost:3260/ilp',
        gatewayHandoverRoute: true,
      }).gateway.run
    ).toBe(true);
  });
});

describe('the tally', () => {
  it('records a pass, its assertions and what it spent', async () => {
    const run = new SmokeRun('Local sandbox', 'http://c', 'ws://r');
    const value = await run.run('signin', async (step) => {
      step.fact('signed in');
      step.spent('11');
      return 'the account';
    });
    expect(value).toBe('the account');
    const report = run.report();
    expect(report.passed).toBe(1);
    expect(report.spent).toBe('11');
    expect(report.stages[0]?.detail).toBe('signed in');
    expect(report.verdict).toBe('green');
  });

  it('counts a skip as a skip and never as a pass', async () => {
    const run = new SmokeRun('Devnet', 'http://c', 'ws://r');
    const value = await run.run('gateway', async (step) => {
      step.skip('this network has none');
      return 'unreachable';
    });
    expect(value).toBeUndefined();
    const report = run.report();
    expect(report.passed).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.verdict).toBe('green');
    expect(run.passed('gateway')).toBe(false);
  });

  it('turns a failed assertion into a red verdict with the sentence that failed', async () => {
    const run = new SmokeRun('Devnet', 'http://c', 'ws://r');
    await run.run('extend', async (step) => {
      step.fact('the route was priced');
      step.spent('1100');
      must(false, 'the expiry did not move');
    });
    const report = run.report();
    expect(report.failed).toBe(1);
    expect(report.verdict).toBe('red');
    expect(report.stages[0]?.detail).toBe('the expiry did not move');
    // A stage that failed on a paid route still spent: it must be counted.
    expect(report.spent).toBe('1100');
    expect(report.stages[0]?.facts).toEqual(['the route was priced']);
  });

  it('catches a stage that threw something nobody expected', async () => {
    const run = new SmokeRun('Devnet', 'http://c', 'ws://r');
    await run.run('spawn', async () => {
      throw new TypeError('undefined is not a function');
    });
    expect(run.report().failed).toBe(1);
    expect(run.report().stages[0]?.detail).toContain('undefined is not a function');
  });

  it('adds what every stage spent, and reports what is left', async () => {
    const run = new SmokeRun('Local sandbox', 'http://c', 'ws://r');
    run.settles('solana', 'H8HS…');
    await run.run('spawn', async (step) => {
      step.spent('1100');
      step.fact('bought');
    });
    await run.run('extend', async (step) => {
      step.spent('1100');
      step.spent(undefined); // "nothing was reported" is not zero, and not a throw
      step.fact('extended');
    });
    run.leaves('900');
    const report = run.report();
    expect(report.spent).toBe('2200');
    expect(report.residual).toBe('900');
    expect(report.chain).toBe('solana');
  });
});

describe('the ending', () => {
  it('names every skipped stage and why, even on a green run', async () => {
    const run = new SmokeRun('Devnet', 'http://c', 'ws://r');
    await run.run('signin', async (step) => step.fact('in'));
    await run.run('hidden', async (step) => step.skip('no hidden provider here'));
    const text = summarize(run.report());
    expect(text).toContain('GREEN');
    expect(text).toContain('NOT PROVED on this network (1)');
    expect(text).toContain('no hidden provider here');
  });

  it('names the stages a failure stopped it from reaching', async () => {
    const run = new SmokeRun('Local sandbox', 'http://c', 'ws://r');
    await run.run('daemon', async (step) => step.fact('up'));
    await run.run('funds', async () => must(false, 'the funder holds nothing'));
    const text = summarize(run.report());
    expect(text).toContain('RED');
    expect(text).toContain('NOT REACHED');
    // The rule this whole file exists for: a stage that never ran is not a
    // stage that passed, and the reader is told so by name.
    expect(text).toContain('terminate');
    expect(text).toContain('recover');
    expect(text).not.toContain('Nothing was skipped');
  });

  it('says that a failed paid stage may have spent more than it reported', async () => {
    const run = new SmokeRun('Devnet', 'http://c', 'ws://r');
    await run.run('spawn', async () => must(false, 'the provider refused'));
    expect(summarize(run.report())).toContain('billed like an acceptance');
  });

  it('says so out loud when every stage it knows ran', async () => {
    const run = new SmokeRun('Local sandbox', 'http://c', 'ws://r');
    for (const stage of STAGES) {
      await run.run(stage, async (step) => step.fact('done'));
    }
    const text = summarize(run.report());
    expect(text).toContain('Nothing was skipped');
    expect(text).not.toContain('NOT REACHED');
  });
});

describe('the assertion helpers', () => {
  it('carries the sentence a reader needs', () => {
    expect(() => must(false, 'the card reads running')).toThrow('the card reads running');
    expect(() => present(undefined, 'the spawn returned no lease')).toThrow(
      'the spawn returned no lease'
    );
    expect(present('x', 'never')).toBe('x');
  });
});

describe('the image a Template is published for', () => {
  it('reads a two-part Docker Hub name, a library name and a private registry', () => {
    expect(parseImageRef('traefik/whoami:v1.10.2', 'registry-1.docker.io')).toEqual({
      registry: 'registry-1.docker.io',
      repository: 'traefik/whoami',
      tag: 'v1.10.2',
    });
    expect(parseImageRef('alpine', 'registry-1.docker.io')).toEqual({
      registry: 'registry-1.docker.io',
      repository: 'library/alpine',
      tag: 'latest',
    });
    // A port is not a tag.
    expect(
      parseImageRef('registry.example:5000/team/app:1.2', 'registry-1.docker.io')
    ).toEqual({
      registry: 'registry.example:5000',
      repository: 'team/app',
      tag: '1.2',
    });
  });

  it("picks the platform manifest for the Listing's own arch", () => {
    const index = {
      manifests: [
        {
          digest: `sha256:${'a'.repeat(64)}`,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          platform: { architecture: 'arm64', os: 'linux' },
        },
        {
          digest: `sha256:${'b'.repeat(64)}`,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          platform: { architecture: 'amd64', os: 'linux' },
        },
      ],
    };
    expect(pickPlatform(index, 'amd64')?.digest).toBe(`sha256:${'b'.repeat(64)}`);
    // Buying an amd64 lease with a riscv manifest is paying for a workload
    // that cannot start, so there is no fallback.
    expect(pickPlatform(index, 'riscv64')).toBeUndefined();
  });

  it('turns a manifest into an entry whose every blob names an OCI source', () => {
    const entry = entryFromManifest({
      manifest: {
        config: {
          digest: `sha256:${'c'.repeat(64)}`,
          size: 1018,
          mediaType: 'application/vnd.oci.image.config.v1+json',
        },
        layers: [
          {
            digest: `sha256:${'d'.repeat(64)}`,
            size: 2226327,
            mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
          },
        ],
      },
      manifestDigest: `sha256:${'e'.repeat(64)}`,
      manifestMediaType: 'application/vnd.oci.image.manifest.v1+json',
      manifestSize: 673,
      registry: 'registry-1.docker.io',
      repository: 'traefik/whoami',
    });
    expect(entry.digest).toBe(`sha256:${'e'.repeat(64)}`);
    // The manifest is the first blob and carries the entry's own digest: a
    // reader that could not fetch it could not fetch anything else either.
    expect(entry.blobs[0]?.digest).toBe(entry.digest);
    expect(entry.blobs).toHaveLength(3);
    for (const blob of entry.blobs) {
      expect(blob.source).toEqual({
        type: 'oci',
        registry: 'registry-1.docker.io',
        repository: 'traefik/whoami',
      });
      expect(blob.size).toBeGreaterThan(0);
      expect(blob.media_type).not.toBe('');
    }
  });

  it('refuses a manifest that describes no image rather than publishing half of one', () => {
    expect(() =>
      entryFromManifest({
        manifest: { layers: [] },
        manifestDigest: `sha256:${'e'.repeat(64)}`,
        manifestMediaType: 'application/vnd.oci.image.manifest.v1+json',
        manifestSize: 1,
        registry: 'r',
        repository: 'x/y',
      })
    ).toThrow(/config blob/u);
  });
});

describe('the arguments', () => {
  it('runs against the local sandbox unless told otherwise', () => {
    const args = parseArgs([], {});
    expect(args.profile.id).toBe(SANDBOX.id);
    expect(args.profile.connectorUrl).toBe(SANDBOX.connectorUrl);
    expect(args.keep).toBe(false);
    // The funder falls back to the development phrase every local chain in
    // this fleet is seeded with, so a sandbox run needs no environment at all.
    expect(args.funder.split(' ')).toHaveLength(12);
  });

  it('points the same run at devnet, and lets every endpoint be overridden', () => {
    const args = parseArgs(
      [
        '--profile',
        'devnet',
        '--connector',
        'http://c/ilp',
        '--relay',
        'ws://r',
        '--gateway',
        'http://g',
      ],
      {}
    );
    expect(args.profile.id).toBe('devnet');
    expect(args.profile.connectorUrl).toBe('http://c/ilp');
    expect(args.profile.relayUrl).toBe('ws://r');
    expect(args.profile.gatewayConnectorUrl).toBe('http://g');
  });

  it('refuses a phrase that is not a phrase rather than failing mid-run', () => {
    expect(() => parseArgs([], { TOON_SMOKE_FUNDER_MNEMONIC: 'not a phrase' })).toThrow(
      /BIP-39/u
    );
    expect(() => parseArgs([], { TOON_SMOKE_CHAIN_SEED: 'also not a phrase' })).toThrow(
      /BIP-39/u
    );
  });

  it('refuses an unknown profile and an unknown flag', () => {
    expect(() => parseArgs(['--profile', 'moon'], {})).toThrow(/No profile/u);
    expect(() => parseArgs(['--wat'], {})).toThrow(/Unknown argument/u);
    expect(() => parseArgs(['--chain'], {})).toThrow(/takes a value/u);
  });

  it('carries the chain, the deposit and the gas through unchanged', () => {
    const args = parseArgs(
      [
        '--chain',
        'solana',
        '--deposit',
        '20000',
        '--gas',
        '1',
        '--listing',
        'basic',
        '--keep',
      ],
      {}
    );
    expect(args.chain).toBe('solana');
    expect(args.deposit).toBe('20000');
    expect(args.gas).toBe('1');
    expect(args.listing).toBe('basic');
    expect(args.keep).toBe(true);
  });
});
