import { describe, expect, it } from 'vitest';

import {
  ANY_GPU,
  K_LISTING,
  K_LIVENESS,
  K_PROFILE,
  LABEL,
  directoryFilters,
  readDirectory,
  type DirectoryFilters,
  type DirectoryView,
} from './directory.js';
import {
  fakeProvider,
  fakeRelays,
  listingEvent,
  livenessEvent,
  profileEvent,
  type FakeRelay,
  type RecordedRequest,
} from './directory.testkit.js';
import type { NetworkProfile } from './profiles.js';
import { queryRelays } from './relay-pool.js';

const SEED = 'wss://seed.test';
const OWN = 'wss://acme.relay.test';
const NOW = new Date('2026-09-22T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

const network: NetworkProfile = {
  id: 'test',
  label: 'Test network',
  description: 'a network for this file only',
  connectorUrl: 'https://connector.test/ilp',
  relayUrl: SEED,
  gatewayDomain: 'gw.test',
  gatewayConnectorUrl: 'http://gateway.test/ilp',
  rpc: {},
  origin: 'built-in',
};

const acme = fakeProvider('acme');
const shady = fakeProvider('shady');
const ghost = fakeProvider('ghost');

/** The whole of a small network, published the way §4 says to publish it. */
function wholeNetwork() {
  return {
    profile: profileEvent(acme, { relays: [SEED, OWN], host: '203.0.113.7', cadence: 60 }),
    basic: listingEvent(acme, { name: 'basic', price: 1000, standbyPrice: 400 }),
    ci: listingEvent(acme, { name: 'ci', price: 5000, capabilities: ['docker'] }),
    gpu: listingEvent(acme, { name: 'gpu', price: 20_000, gpu: 'nvidia-a100-80gb' }),
    arm: listingEvent(acme, { name: 'arm', price: 800, arch: 'arm64' }),
    liveness: livenessEvent(acme, {
      expiresAt: NOW_S + 120,
      available: { basic: 3, ci: 1, gpu: 0, arm: 2 },
    }),
    hiddenProfile: profileEvent(shady, { hidden: true, relays: [SEED] }),
    hiddenListing: listingEvent(shady, { name: 'quiet', price: 9000, hiddenLabel: true }),
    hiddenLiveness: livenessEvent(shady, { expiresAt: NOW_S + 90, available: { quiet: 1 } }),
  };
}

async function read(
  relays: readonly FakeRelay[],
  filters: DirectoryFilters = {},
  now: Date = NOW
): Promise<{ view: DirectoryView; requests: RecordedRequest[] }> {
  const { dial, requests } = fakeRelays(relays);
  const result = await readDirectory({
    profile: network,
    filters,
    now,
    query: (query) => queryRelays({ ...query, dial, timeoutMs: 2_000 }),
  });
  if (result.state !== 'ok') throw new Error(`expected a directory, got ${result.state}`);
  return { view: result, requests };
}

const names = (view: DirectoryView) =>
  view.providers
    .flatMap((provider) => provider.listings.map((listing) => listing.name))
    .sort();

describe('reading the Provider Directory', () => {
  it('shows Profiles, Listings and Liveness together, per provider', async () => {
    const n = wholeNetwork();
    const { view } = await read([
      { url: SEED, events: [n.profile, n.basic, n.ci, n.liveness] },
      { url: OWN, events: [n.profile, n.basic, n.ci, n.liveness] },
    ]);

    expect(view.providers).toHaveLength(1);
    const provider = view.providers[0];
    expect(provider?.pubkey).toBe(acme.pubkey);
    // The Profile says where it is reached and paid; ADR 0002 keeps that out
    // of the Listings, and the console puts the two back together here.
    expect(provider?.profile.connectorUrl).toBe('https://connector.test/ilp');
    expect(provider?.profile.host).toBe('203.0.113.7');
    expect(provider?.listings.map((l) => l.name)).toEqual(['basic', 'ci']);
    expect(provider?.liveness.state).toBe('live');
  });

  it("reads each provider's own Relay Set, not only the relay it was found on", async () => {
    const n = wholeNetwork();
    // The seed relay has the Profile and one tier. The provider's OWN relay
    // has the rest — including its Liveness, which is what §4 tells a provider
    // to publish there.
    const { view, requests } = await read([
      { url: SEED, events: [n.profile, n.basic] },
      { url: OWN, events: [n.profile, n.ci, n.liveness] },
    ]);

    expect(names(view)).toEqual(['basic', 'ci']);
    expect(view.providers[0]?.liveness.state).toBe('live');
    expect([...(view.providers[0]?.relaysRead ?? [])].sort()).toEqual([OWN, SEED].sort());

    // The second pass asks that relay about that provider and nobody else.
    const second = requests.filter((request) => request.url === OWN);
    expect(second).toHaveLength(1);
    expect(
      second[0]?.filters.every((f) => (f.authors as string[]).includes(acme.pubkey))
    ).toBe(true);
  });

  it('still shows a directory when one relay of a Relay Set is down', async () => {
    const n = wholeNetwork();
    const { view } = await read([
      { url: SEED, events: [n.profile, n.basic, n.liveness] },
      { url: OWN, events: [], broken: true },
    ]);

    expect(names(view)).toEqual(['basic']);
    expect(view.relays.read.find((r) => r.url === OWN)?.state).toBe('failed');
    expect(view.relays.read.find((r) => r.url === SEED)?.state).toBe('read');
  });

  it('does not show a superseded Listing version as current', async () => {
    const n = wholeNetwork();
    // ADR 0009: a price change is a new version of the SAME listing. The two
    // relays disagree about which is current, and they arrive in that order.
    const v1 = listingEvent(acme, {
      name: 'basic',
      version: 1,
      price: 1000,
      createdAt: NOW_S - 60,
    });
    const v2 = listingEvent(acme, {
      name: 'basic',
      version: 2,
      price: 2500,
      createdAt: NOW_S - 10,
    });

    const { view } = await read([
      { url: SEED, events: [n.profile, v2] },
      { url: OWN, events: [n.profile, v1] },
    ]);

    const listings = view.providers[0]?.listings ?? [];
    expect(listings).toHaveLength(1);
    expect(listings[0]?.version).toBe(2);
    expect(listings[0]?.price).toBe(2500);
    expect(listings[0]?.eventId).toBe(v2.id);
    expect(view.providers[0]?.supersededListings).toBe(1);
  });

  it('prices each Listing per Lease Interval, and says when a tier sells no standby', async () => {
    const n = wholeNetwork();
    const { view } = await read([
      { url: SEED, events: [n.profile, n.basic, n.ci, n.liveness] },
    ]);
    const listings = view.providers[0]?.listings ?? [];

    const basic = listings.find((listing) => listing.name === 'basic');
    expect(basic?.price).toBe(1000);
    expect(basic?.leaseIntervalSeconds).toBe(3600);
    expect(basic?.standbyPrice).toBe(400);
    // Absent, never zero (§4.2): this tier sells no Warm Standby at all.
    expect(listings.find((listing) => listing.name === 'ci')?.standbyPrice).toBeUndefined();
    // What Liveness says could start right now, per tier (§4.3).
    expect(basic?.available).toBe(3);
  });

  it('names the address a spawn will buy', async () => {
    const n = wholeNetwork();
    const { view } = await read([{ url: SEED, events: [n.profile, n.basic] }]);
    expect(view.providers[0]?.listings[0]?.address).toBe(`${K_LISTING}:${acme.pubkey}:basic`);
  });

  it('refuses a Listing whose Provider Profile is on no relay it read', async () => {
    const n = wholeNetwork();
    const orphan = listingEvent(ghost, { name: 'orphan', price: 1 });
    const { view } = await read([{ url: SEED, events: [n.profile, n.basic, orphan] }]);

    expect(view.providers.map((provider) => provider.pubkey)).toEqual([acme.pubkey]);
    expect(view.listingsWithoutProfile).toBe(1);
  });
});

describe('liveness', () => {
  it('is live while its own expiration has not passed, and stale once it has', async () => {
    const n = wholeNetwork();
    const relays = [{ url: SEED, events: [n.profile, n.basic, n.liveness] }];

    const live = await read(relays, {}, new Date((NOW_S + 119) * 1000));
    expect(live.view.providers[0]?.liveness.state).toBe('live');
    expect(live.view.providers[0]?.liveness.secondsUntilExpiry).toBe(1);
    expect(live.view.providers[0]?.liveness.cadenceSeconds).toBe(60);

    // Nothing was republished and nothing was re-read: the SAME event, read a
    // minute later, is no longer a claim that the provider is up (ADR 0007).
    const later = await read(relays, {}, new Date((NOW_S + 121) * 1000));
    expect(later.view.providers[0]?.liveness.state).toBe('stale');
    expect(later.view.providers[0]?.liveness.secondsUntilExpiry).toBe(-1);
  });

  it('is unknown when no relay holds one, rather than stale', async () => {
    const n = wholeNetwork();
    const { view } = await read([{ url: SEED, events: [n.profile, n.basic] }]);
    expect(view.providers[0]?.liveness.state).toBe('unknown');
    expect(view.providers[0]?.listings[0]?.available).toBeUndefined();
  });

  it('sorts live providers above stale ones', async () => {
    const n = wholeNetwork();
    const { view } = await read([
      {
        url: SEED,
        events: [
          n.profile,
          listingEvent(acme, { name: 'basic', price: 9999 }),
          livenessEvent(acme, { expiresAt: NOW_S - 1 }),
          n.hiddenProfile,
          n.hiddenListing,
          n.hiddenLiveness,
        ],
      },
    ]);
    expect(view.providers.map((provider) => provider.liveness.state)).toEqual([
      'live',
      'stale',
    ]);
  });
});

describe('filters', () => {
  const everything = () => {
    const n = wholeNetwork();
    return [
      {
        url: SEED,
        events: [
          n.profile,
          n.basic,
          n.ci,
          n.gpu,
          n.arm,
          n.liveness,
          n.hiddenProfile,
          n.hiddenListing,
          n.hiddenLiveness,
        ],
      },
    ];
  };

  it('filters by arch', async () => {
    expect(names((await read(everything(), { arch: 'arm64' })).view)).toEqual(['arm']);
    expect(names((await read(everything(), { arch: 'amd64' })).view)).toEqual([
      'basic',
      'ci',
      'gpu',
      'quiet',
    ]);
  });

  it('filters by isolation', async () => {
    expect(names((await read(everything(), { isolation: 'dedicated-host' })).view)).toEqual(
      []
    );
    expect(
      names((await read(everything(), { isolation: 'shared-kernel' })).view)
    ).toHaveLength(5);
  });

  it('filters by a named GPU, and by having one at all', async () => {
    expect(names((await read(everything(), { gpu: ANY_GPU })).view)).toEqual(['gpu']);
    expect(names((await read(everything(), { gpu: 'nvidia-a100-80gb' })).view)).toEqual([
      'gpu',
    ]);
    expect(names((await read(everything(), { gpu: 'nvidia-rtx-4090' })).view)).toEqual([]);
  });

  it('wants every capability asked for, not any of them', async () => {
    expect(names((await read(everything(), { capabilities: ['docker'] })).view)).toEqual([
      'ci',
    ]);
    expect(
      names((await read(everything(), { capabilities: ['docker', 'nesting'] })).view)
    ).toEqual([]);
  });

  it('never reads an `x-` capability as the specified one', async () => {
    const n = wholeNetwork();
    const experimental = listingEvent(acme, { name: 'x', capabilities: ['x-docker'] });
    const relays = [{ url: SEED, events: [n.profile, experimental, n.ci] }];
    expect(names((await read(relays, { capabilities: ['docker'] })).view)).toEqual(['ci']);
    expect(names((await read(relays, { capabilities: ['x-docker'] })).view)).toEqual(['x']);
    const { view } = await read(relays);
    const listing = view.providers[0]?.listings.find((candidate) => candidate.name === 'x');
    expect(listing?.unspecifiedCapabilities).toEqual(['x-docker']);
  });

  it('shows Hidden Providers alongside the rest, only them, or none of them', async () => {
    expect(names((await read(everything())).view)).toContain('quiet');
    expect(names((await read(everything(), { hidden: true })).view)).toEqual(['quiet']);
    expect(names((await read(everything(), { hidden: false })).view)).not.toContain('quiet');
  });

  it('never publishes a host for a Hidden Provider, even if its Profile carried one', async () => {
    const leaky = profileEvent(shady, { hidden: true, host: '198.51.100.9', relays: [SEED] });
    const n = wholeNetwork();
    const { view } = await read([{ url: SEED, events: [leaky, n.hiddenListing] }]);
    expect(view.providers[0]?.profile.hidden).toBe(true);
    expect(view.providers[0]?.profile.host).toBeUndefined();
  });

  it('asks the relay for the tags NIP-01 can express, and re-checks every one itself', async () => {
    const { requests } = await read(everything(), {
      isolation: 'shared-kernel',
      arch: 'amd64',
      capabilities: ['docker'],
      hidden: true,
    });
    const listingFilter = requests[0]?.filters.find((filter) =>
      (filter.kinds as number[]).includes(K_LISTING)
    );
    expect(listingFilter?.['#l']).toEqual([
      'isolation:shared-kernel',
      'arch:amd64',
      'hidden:true',
    ]);
    expect(listingFilter?.['#t']).toEqual(['docker']);

    // The Profiles and Liveness are asked for WITHOUT those tags: they carry
    // none, and a Listing with no Profile is not purchasable (§4.2).
    const otherFilter = requests[0]?.filters.find((filter) =>
      (filter.kinds as number[]).includes(K_PROFILE)
    );
    expect(otherFilter?.['#l']).toBeUndefined();
    expect(otherFilter?.kinds).toEqual([K_PROFILE, K_LIVENESS]);
    expect(otherFilter?.['#L']).toEqual([LABEL]);
  });

  it('drops a listing a relay served that the filter did not ask for', async () => {
    // A relay that answers something else is a relay whose answer must not be
    // shown; the local check is not a duplicate of the relay's.
    const n = wholeNetwork();
    const { dial } = fakeRelays([
      { url: SEED, events: [n.profile, n.basic, n.arm, n.liveness] },
    ]);
    const result = await readDirectory({
      profile: network,
      filters: { arch: 'arm64' },
      now: NOW,
      // A relay that ignores `#l` entirely.
      query: (query) =>
        queryRelays({
          ...query,
          filters: query.filters.map((filter) => {
            const { ['#l']: _l, ['#t']: _t, ...rest } = filter;
            return rest;
          }),
          dial,
          timeoutMs: 2_000,
        }),
    });
    if (result.state !== 'ok') throw new Error('expected a directory');
    expect(names(result)).toEqual(['arm']);
  });

  it('has no relay filter for "not hidden", because absence is not a tag', () => {
    const forHidden = directoryFilters({ hidden: true })[1] as Record<string, unknown>;
    const against = directoryFilters({ hidden: false })[1] as Record<string, unknown>;
    expect(forHidden['#l']).toEqual(['hidden:true']);
    expect(against['#l']).toBeUndefined();
  });
});

describe('a Listing that cannot be bought', () => {
  it('is refused when its `gpu:` label and its `resources.gpu` disagree', async () => {
    const n = wholeNetwork();
    const crooked = listingEvent(acme, {
      name: 'crooked',
      gpu: 'nvidia-a100-80gb',
      gpuLabel: 'nvidia-rtx-4090',
    });
    const { view } = await read([{ url: SEED, events: [n.profile, n.basic, crooked] }]);
    expect(names(view)).toEqual(['basic']);
    expect(view.providers[0]?.rejectedListings[0]).toMatchObject({ name: 'crooked' });
  });

  it('is refused when its `gpu:` label breaks §4.4’s grammar', async () => {
    const n = wholeNetwork();
    const shouty = listingEvent(acme, { name: 'shouty', gpu: 'NVIDIA_A100' });
    const { view } = await read([{ url: SEED, events: [n.profile, n.basic, shouty] }]);
    expect(names(view)).toEqual(['basic']);
  });

  it('is refused when it claims `hidden:true` and its Profile does not', async () => {
    const n = wholeNetwork();
    const pretend = listingEvent(acme, { name: 'pretend', hiddenLabel: true });
    const { view } = await read([{ url: SEED, events: [n.profile, n.basic, pretend] }]);
    expect(names(view)).toEqual(['basic']);
    expect(view.providers[0]?.rejectedListings[0]?.reason).toMatch(/hidden/);
  });

  it("is refused when a Hidden Provider's Listing carries no `hidden:true`", async () => {
    const n = wholeNetwork();
    const bare = listingEvent(shady, { name: 'bare' });
    const { view } = await read([{ url: SEED, events: [n.hiddenProfile, bare] }]);
    expect(view.providers).toHaveLength(0);
  });
});

describe('a network with nothing behind it', () => {
  it('says so rather than reading nowhere', async () => {
    const result = await readDirectory({
      profile: { ...network, relayUrl: '', connectorUrl: '' },
      now: NOW,
    });
    expect(result.state).toBe('unconfigured');
  });
});
