import { describe, expect, it } from 'vitest';

import {
  NO_RELAY_LIST,
  normalizeRelayUrl,
  parseRelayList,
  readRelayListOf,
  relayListTemplate,
  RelayListError,
  RELAY_LIST_KIND,
} from './relay-list.js';
import {
  fakeAccount,
  fakeRelayNetwork,
  fakeRelayServer,
  publishRelayListEvent,
} from './chain-seed.testkit.js';
import type { NostrEvent } from './nostr.js';

/**
 * NIP-65, both halves.
 *
 * The read half decided where a kind-0 is looked for (#88). The write half
 * decides where an account's sealed Chain Seed GOES (#89), which is money
 * rather than a display name — so the parsing is tested for what it drops as
 * much as for what it keeps.
 */

function listEvent(tags: string[][], createdAt = 1_790_000_000): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    sig: 'c'.repeat(128),
    kind: RELAY_LIST_KIND,
    created_at: createdAt,
    tags,
    content: '',
  };
}

describe('parsing a relay list', () => {
  it('reads a bare `r` as both directions, per the NIP', () => {
    const list = parseRelayList(listEvent([['r', 'wss://one.test']]));
    expect(list.read).toEqual(['wss://one.test']);
    expect(list.write).toEqual(['wss://one.test']);
    expect(list.entries).toEqual([{ url: 'wss://one.test', mode: 'both' }]);
  });

  it('keeps read and write apart', () => {
    const list = parseRelayList(
      listEvent([
        ['r', 'wss://in.test', 'read'],
        ['r', 'wss://out.test', 'write'],
      ])
    );
    expect(list.read).toEqual(['wss://in.test']);
    expect(list.write).toEqual(['wss://out.test']);
  });

  it('folds a relay listed both ways into one entry', () => {
    const list = parseRelayList(
      listEvent([
        ['r', 'wss://one.test', 'read'],
        ['r', 'wss://one.test', 'write'],
      ])
    );
    expect(list.entries).toEqual([{ url: 'wss://one.test', mode: 'both' }]);
    expect(list.write).toEqual(['wss://one.test']);
  });

  it('drops a marker it does not understand rather than guessing', () => {
    const list = parseRelayList(listEvent([['r', 'wss://one.test', 'archive']]));
    expect(list.entries).toEqual([]);
  });

  it('drops anything that is not a websocket relay', () => {
    const list = parseRelayList(
      listEvent([
        ['r', 'https://not-a-relay.test'],
        ['r', 'nonsense'],
        ['r', ''],
        ['p', 'wss://wrong-tag.test'],
      ])
    );
    expect(list).toMatchObject({ entries: [], read: [], write: [] });
  });

  it('is empty, not an error, when the account has published nothing', () => {
    expect(parseRelayList(undefined)).toEqual(NO_RELAY_LIST);
  });
});

describe('normalizing a relay URL', () => {
  it('settles on one spelling for the same relay', () => {
    expect(normalizeRelayUrl('wss://one.test/')).toBe('wss://one.test');
    expect(normalizeRelayUrl('  wss://one.test  ')).toBe('wss://one.test');
    expect(normalizeRelayUrl('wss://one.test/inbox')).toBe('wss://one.test/inbox');
  });

  it('refuses anything that is not ws or wss', () => {
    expect(normalizeRelayUrl('http://one.test')).toBeUndefined();
    expect(normalizeRelayUrl(42)).toBeUndefined();
  });
});

describe('building a relay list to publish', () => {
  it('writes a bare `r` for both and a marker otherwise', () => {
    const template = relayListTemplate(
      [{ url: 'wss://one.test/' }, { url: 'wss://two.test', mode: 'read' }],
      1_790_000_000
    );
    expect(template.kind).toBe(RELAY_LIST_KIND);
    expect(template.tags).toEqual([
      ['r', 'wss://one.test'],
      ['r', 'wss://two.test', 'read'],
    ]);
  });

  it('refuses a URL that is not a relay, by name', () => {
    expect(() => relayListTemplate([{ url: 'relay.test' }], 0)).toThrow(RelayListError);
  });

  it('refuses to publish an empty list, which would take the account off Nostr', () => {
    expect(() => relayListTemplate([], 0)).toThrow(/at least one/u);
  });
});

describe('reading an account’s list off relays', () => {
  it('takes the newest one, whichever relay answered first', async () => {
    const account = fakeAccount();
    const stale = fakeRelayServer('wss://stale.test');
    const fresh = fakeRelayServer('wss://fresh.test');
    await publishRelayListEvent(account, [stale], ['wss://old.test'], 1_790_000_000);
    await publishRelayListEvent(account, [fresh], ['wss://new.test'], 1_790_000_900);

    const list = await readRelayListOf(account.pubkey, [stale.url, fresh.url], {
      dial: fakeRelayNetwork([stale, fresh]),
      timeoutMs: 200,
    });
    expect(list.write).toEqual(['wss://new.test']);
  });

  it('has nothing to say when there is nowhere to ask', async () => {
    expect(await readRelayListOf('a'.repeat(64), [])).toEqual(NO_RELAY_LIST);
  });
});
