import type { NodeSelfDescription } from '@toon-protocol/client';
import { describe, expect, it } from 'vitest';

import { readConnectorHealth, type ConnectorReader } from './connector-health.js';
import { DEVNET, MAINNET } from './profiles.js';

/** A connector's answer, shaped as the devnet relay edge really answers. */
const DESCRIPTION: NodeSelfDescription = {
  ilpAddresses: ['g.toon.relay', 'g.toon.relay.ephemeral'],
  httpEndpoint: 'https://proxy.relay.devnet.toonprotocol.dev/ilp',
  peerCarriages: [],
  edgeIdentity: { keyId: 'connector-signer', publicKey: '0x04915d' },
  settlements: [
    {
      kind: 'evm',
      chain: 'evm:84532',
      settlementAddress: '0x3f43',
      tokenNetworkRegistry: '0x0c41',
      tokenNetwork: '0xe9e0',
      tokenAddress: '0x49be',
      decimals: 6,
    },
    {
      kind: 'solana',
      chain: 'solana',
      settlementAddress: 'GzvG',
      programId: '2aEV',
      tokenAddress: '34eS',
      decimals: 6,
    },
  ],
  routes: [
    { prefix: 'g.toon.relay', price: 1n },
    { prefix: 'g.toon.relay.store', price: 1001n, pricePerKib: 10n },
  ],
  supportedVersions: [1],
  defaultVersion: 1,
  raw: {},
};

const readerReturning = (description: NodeSelfDescription): ConnectorReader => ({
  describe: () => Promise.resolve(description),
});

describe('readConnectorHealth', () => {
  it('reports the chains the connector says it settles on', async () => {
    const health = await readConnectorHealth(DEVNET, readerReturning(DESCRIPTION));
    expect(health.state).toBe('ok');
    if (health.state !== 'ok') return;
    expect(health.ilpAddresses).toEqual(['g.toon.relay', 'g.toon.relay.ephemeral']);
    expect(health.settlements.map((entry) => entry.chain)).toEqual(['evm:84532', 'solana']);
    expect(health.settlements[0]?.kind).toBe('evm');
    expect(health.edgeKeyId).toBe('connector-signer');
  });

  it('carries prices as strings, because a price outgrows a JSON number', async () => {
    const huge = { ...DESCRIPTION, routes: [{ prefix: 'g.toon.relay', price: 2n ** 64n }] };
    const health = await readConnectorHealth(DEVNET, readerReturning(huge));
    if (health.state !== 'ok') throw new Error('expected ok');
    expect(health.routes[0]?.price).toBe('18446744073709551616');
  });

  it('normalizes the endpoint it reports to the client edge base', async () => {
    const health = await readConnectorHealth(DEVNET, readerReturning(DESCRIPTION));
    if (health.state !== 'ok') throw new Error('expected ok');
    expect(health.endpoint).toBe('https://proxy.relay.devnet.toonprotocol.dev');
  });

  it('says "unconfigured" for a profile with no connector, which is not a fault', async () => {
    const health = await readConnectorHealth(MAINNET, readerReturning(DESCRIPTION));
    expect(health.state).toBe('unconfigured');
  });

  it('says "unreachable" — and keeps the reason — when the connector does not answer', async () => {
    const health = await readConnectorHealth(DEVNET, {
      describe: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });
    expect(health.state).toBe('unreachable');
    if (health.state !== 'unreachable') return;
    expect(health.reason).toContain('ECONNREFUSED');
  });
});
