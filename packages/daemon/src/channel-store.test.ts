import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { channelStoreFor } from './channel-store.js';
import { consolePaths } from './paths.js';

describe('the console channel store', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-channels-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const paths = () => consolePaths({ HOME: home } as NodeJS.ProcessEnv);

  it('roots channel state in the console data directory, one store per profile', () => {
    const devnet = channelStoreFor(paths(), 'devnet');
    const sandbox = channelStoreFor(paths(), 'sandbox');
    expect(devnet.filePath).toContain(join('toon-console', 'profiles', 'devnet', 'channels'));
    expect(sandbox.filePath).toContain(
      join('toon-console', 'profiles', 'sandbox', 'channels')
    );
    expect(devnet.filePath).not.toBe(sandbox.filePath);
    expect(devnet.bindingsPath).not.toBe(devnet.filePath);
  });

  it('is the object seam `ToonClientConfig.channelStore` takes, and keeps bigints whole', () => {
    const { store } = channelStoreFor(paths(), 'devnet');
    const watermark = 2n ** 70n + 7n;
    store.save('0xchannel', { nonce: 3, cumulativeAmount: watermark });

    // Re-open from disk: the same channel state has to survive a restart, and
    // a watermark past 2^53 must not have been rounded through a JSON number.
    const reopened = channelStoreFor(paths(), 'devnet').store;
    expect(reopened.load('0xchannel')).toEqual({ nonce: 3, cumulativeAmount: watermark });
    expect(reopened.list()).toEqual(['0xchannel']);
  });

  it('keeps one profile’s channels invisible to another', () => {
    channelStoreFor(paths(), 'devnet').store.save('0xchannel', {
      nonce: 1,
      cumulativeAmount: 1n,
    });
    expect(channelStoreFor(paths(), 'sandbox').store.load('0xchannel')).toBeUndefined();
  });
});
