import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { JsonFileChannelStore, type ChannelStore } from '@toon-protocol/client';

import { profileDataDir, type ConsolePaths } from './paths.js';

/**
 * Where a profile's payment-channel state lives.
 *
 * `ToonClientConfig.channelStore` takes a path OR a `ChannelStore` object
 * (TOON_Network#85). The daemon passes the OBJECT, and that is the point: the
 * console — not the library's default — decides where channel state sits, so
 * it lands in the console's own data directory beside the Lease Vault cache
 * rather than in whatever directory the process happened to start in.
 *
 * The object it passes still delegates to `JsonFileChannelStore`. What the
 * console owns is the LOCATION and the per-profile split; the on-disk codec is
 * the client's, because a watermark is `bigint` and a second, hand-written
 * JSON encoding of it is a way to lose money, not a way to own a directory.
 *
 * One store per profile, never one shared: a devnet watermark replayed against
 * a sandbox channel is a rejected claim at best, and the two networks' channel
 * ids have no reason to be distinct.
 */

export interface ConsoleChannelStore {
  /** What is handed to `ToonClientConfig.channelStore`. */
  readonly store: ChannelStore;
  /** The watermark file, for the health view and for support questions. */
  readonly filePath: string;
  /** The sibling peer→channel bindings file. */
  readonly bindingsPath: string;
}

export function channelStoreFor(paths: ConsolePaths, profileId: string): ConsoleChannelStore {
  const dir = join(profileDataDir(paths, profileId), 'channels');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'channels.json');
  const bindingsPath = join(dir, 'channels.peers.json');
  return {
    store: new JsonFileChannelStore(filePath, { bindingsPath }),
    filePath,
    bindingsPath,
  };
}

/** One channel this console holds, as the bindings file records it. */
export interface ChannelBinding {
  readonly channelId: string;
  readonly depositTotal?: bigint | undefined;
  readonly openedAt?: string | undefined;
}

/**
 * The channel this account holds with one connector on one chain.
 *
 * Written down once, because four callers ask the same question and each of
 * them decides whether money moves: the funding view (what is this channel
 * worth), a spawn (is there anything to pay from), a relay write (the same),
 * and an extension and its runway (how many more intervals can be bought).
 * Four copies of a key format is four places for a drift that reads as "no
 * channel" — which is survivable — or as the WRONG channel, which is not.
 *
 * The client keys a binding `<connector>|<chain>|<settlement contract>`. The
 * first two fields are facts this console holds; the third is the library's to
 * spell, so it is matched by prefix rather than reconstructed. A key shape that
 * changes costs a "no channel recorded here" and never a wrong channel.
 */
export function findChannelBinding(
  store: ChannelStore,
  connectorUrl: string,
  chain: string
): ChannelBinding | undefined {
  const bindings = store.listBindings?.() ?? [];
  const wanted = bindings.filter(
    (entry) =>
      entry.binding.supersededAt === undefined &&
      entry.key.split('|')[1] === chain &&
      sameConnector(entry.key.split('|')[0] ?? '', connectorUrl)
  );
  const found = wanted.at(-1)?.binding;
  if (!found) return undefined;
  return {
    channelId: found.channelId,
    ...(found.depositTotal === undefined ? {} : { depositTotal: found.depositTotal }),
    ...(found.openedAt === undefined ? {} : { openedAt: found.openedAt }),
  };
}

/**
 * What a channel has left: its collateral less what this console has signed
 * claims for.
 *
 * `undefined` when either half is unknown, and never a zero standing in for
 * one: a balance that lies is worse than one that says nothing, and this
 * figure is what a runway is counted in.
 */
export function channelAvailable(
  store: ChannelStore,
  binding: ChannelBinding
): bigint | undefined {
  const watermark = store.load(binding.channelId);
  const spent = watermark?.cumulativeAmount;
  if (binding.depositTotal === undefined || spent === undefined) return undefined;
  return binding.depositTotal - spent;
}

/** `https://node.example` and `https://node.example/ilp` are the same node. */
export function sameConnector(a: string, b: string): boolean {
  const base = (url: string) => url.replace(/\/+$/u, '').replace(/\/ilp$/u, '');
  return base(a) === base(b);
}
