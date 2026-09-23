import type { ChannelStore } from '@toon-protocol/client';
import { describe, expect, it } from 'vitest';

import { LeaseBodyError } from './lease-body.js';
import { LiveProviderPort } from './lease-route.js';
import type { LeasePacket } from './lease.js';

/**
 * **The wrong shape never becomes a signed claim** (TOON_Network#115, spec §5,
 * ADR 0003, ADR 0025).
 *
 * The real port, with no connector anywhere near it, because the ordering is
 * the whole assertion: a packet whose body does not match its route is refused
 * BEFORE a `ToonClient` is built, so before a channel is opened, before a
 * balance proof is signed, and before anything reaches the wire. A connector
 * collects a paid route's price before the provider app reads a byte, so an
 * extension wrapped like its neighbours would be `invalid_request` at the full
 * price of a Lease Interval, with no refund.
 *
 * `payAt` points at a port nothing listens on, which is what makes the
 * difference visible: a WELL-FORMED packet gets as far as building the client
 * and comes back `refused`/`CLIENT`, while a malformed one throws instead and
 * never gets that far.
 */
const NOWHERE = 'http://127.0.0.1:9';
const ID = 'a'.repeat(64);

const store = {
  load: () => Promise.resolve(undefined),
  save: () => Promise.resolve(),
} as unknown as ChannelStore;

const packet = (route: string, body: unknown): LeasePacket => ({
  payAt: NOWHERE,
  sealTo: 'b'.repeat(64),
  route,
  body,
  chainKind: 'evm',
  rpcUrl: NOWHERE,
  keys: {
    evm: { privateKey: new Uint8Array(32).fill(1), address: `0x${'1'.repeat(40)}` },
    solana: { secretKey: new Uint8Array(64).fill(1), publicKey: 'Sol' },
  },
  channelStore: store,
  timeoutMs: 1_000,
});

describe('LiveProviderPort — the body is checked before the client is built', () => {
  const port = new LiveProviderPort();

  it('throws on an extension wrapped as a Lease Request, so NO PAYMENT LEAVES THE CHANNEL', async () => {
    const wrapped = {
      request: {
        request_id: 'c'.repeat(64),
        op: 'status',
        provider: 'd'.repeat(64),
        expiration: 1_800_000_000,
        continuation: 'e'.repeat(64),
        content: { workload_id: ID },
      },
    };

    await expect(
      port.send(packet('g.toon.provider.basic.v1.extend', wrapped))
    ).rejects.toThrow(LeaseBodyError);
  });

  it('throws on a bare body sent to an enveloped route', async () => {
    await expect(
      port.send(packet('g.toon.provider.terminate', { workload_id: ID }))
    ).rejects.toThrow(LeaseBodyError);
  });

  it('gets past the check with the right shape, and fails at the connector instead', async () => {
    // Not an assertion about the connector — an assertion that the shape check
    // is not what stopped it. A refusal is returned here, never thrown.
    const outcome = await port.send(
      packet('g.toon.provider.basic.v1.extend', { workload_id: ID })
    );

    expect(outcome.kind).not.toBe('answered');
    if (outcome.kind === 'refused') expect(outcome.code).toBe('CLIENT');
  });
});
