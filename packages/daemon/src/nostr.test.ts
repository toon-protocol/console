import { describe, expect, it } from 'vitest';

import { fakeProvider, listingEvent, profileEvent } from './directory.testkit.js';
import {
  CurrentEvents,
  expirationOf,
  eventId,
  supersedes,
  tagValues,
  verifyEvent,
} from './nostr.js';

const acme = fakeProvider('acme');
const other = fakeProvider('other');

describe('reading a relay', () => {
  it('accepts an event the provider really signed', () => {
    expect(verifyEvent(profileEvent(acme))).toBe(true);
  });

  it('refuses an event whose content was changed under its id', () => {
    const event = profileEvent(acme);
    const tampered = {
      ...event,
      content: event.content.replace('g.test.provider', 'g.attacker'),
    };
    expect(eventId(tampered)).not.toBe(tampered.id);
    expect(verifyEvent(tampered)).toBe(false);
  });

  it("refuses an event served under someone else's pubkey", () => {
    // A relay re-labelling a Listing is a relay choosing who a person pays.
    const event = listingEvent(acme, { name: 'basic' });
    expect(verifyEvent({ ...event, pubkey: other.pubkey })).toBe(false);
  });

  it('refuses whatever else a relay sends, rather than throwing', () => {
    for (const junk of [null, 42, 'EVENT', {}, { id: 'nope' }, { tags: [[1]] }]) {
      expect(verifyEvent(junk)).toBe(false);
    }
  });

  it('reads every value of a repeated tag, in order', () => {
    const event = listingEvent(acme, { name: 'gpu', gpu: 'nvidia-a100-80gb' });
    expect(tagValues(event, 'l')).toEqual([
      'isolation:shared-kernel',
      'arch:amd64',
      'gpu:nvidia-a100-80gb',
    ]);
  });

  it('reads the expiration a Liveness carries, and nothing from one that has none', () => {
    const event = listingEvent(acme, { name: 'basic' });
    expect(expirationOf(event)).toBeUndefined();
    expect(expirationOf({ ...event, tags: [['expiration', '1790000123']] })).toBe(
      1_790_000_123
    );
  });
});

describe("NIP-01's replacement rule", () => {
  const older = listingEvent(acme, { name: 'basic', version: 1, createdAt: 1_790_000_000 });
  const newer = listingEvent(acme, { name: 'basic', version: 2, createdAt: 1_790_000_100 });

  it('takes the later event', () => {
    expect(supersedes(newer, older)).toBe(true);
    expect(supersedes(older, newer)).toBe(false);
  });

  it('breaks a tie on the same second by the lower id', () => {
    const left = listingEvent(acme, { name: 'a', createdAt: 1_790_000_000 });
    const right = listingEvent(acme, { name: 'b', createdAt: 1_790_000_000 });
    const [low, high] = left.id < right.id ? [left, right] : [right, left];
    expect(supersedes(low, high)).toBe(true);
    expect(supersedes(high, low)).toBe(false);
  });

  it('keeps the current version whichever order the relays answered in', () => {
    for (const order of [
      [older, newer],
      [newer, older],
    ]) {
      const held = new CurrentEvents();
      for (const event of order) held.offer('basic', event);
      expect(held.get('basic')?.id).toBe(newer.id);
      expect(held.supersededCount).toBe(1);
    }
  });

  it('does not count the same event arriving from a second relay as a supersession', () => {
    const held = new CurrentEvents();
    held.offer('basic', newer);
    held.offer('basic', { ...newer });
    expect(held.supersededCount).toBe(0);
  });
});
