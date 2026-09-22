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

export function channelStoreFor(
  paths: ConsolePaths,
  profileId: string
): ConsoleChannelStore {
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
