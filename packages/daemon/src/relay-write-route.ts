import { ToonClient } from '@toon-protocol/client';

import type { RelayPacketOutcome, RelayWritePacket, RelayWritePort } from './relay-write.js';

/**
 * The real paid write, behind `relay-write.ts`'s port.
 *
 * Everything that opens a socket or signs a claim is here; the policy — where
 * a write goes, what it costs, when nothing may be sent — is next door where
 * it can be tested without a connector, a chain or a relay. The provider's
 * `tools/publisher` is the same shape and the same decisions (it is the
 * implementation that has been paying for relay writes since Milestone 1), and
 * this is the console's copy of them.
 *
 * **The carriage is named, not discovered.** `transport: 'btp'`, in so many
 * words, because devnet's relay PINS `g.toon.relay` to BTP: an HTTP one-shot
 * is refused `TRANSPORT_REQUIRED` before the packet is routed. The library's
 * `'auto'` honours a node's `requiredTransport`, but the relay connector
 * advertises `peerCarriages: []` and prices the route without naming a
 * carriage, so `auto` cannot discover the pin and would spend a round trip
 * learning it every time — that gap is TOON_Network#111. Naming BTP is also
 * right on its own terms: a claim carries a strictly increasing nonce per
 * channel, and one ordered socket cannot race its own nonces the way parallel
 * HTTP requests can.
 *
 * **It never opens a channel.** `autoOpenChannel: false`, deliberately: the
 * library's default is to open one on the first send, and an open locks
 * collateral on chain and pays the chain's own gas. `relay-write.ts` checks
 * for a channel first and refuses with somewhere to go.
 *
 * **It never names an amount.** The connector quoted the route's price in its
 * own `GET /ilp`, and the client pays that. The console does not recompute a
 * price anywhere (TOON_Network#82: the client and the connector round a
 * per-KiB charge differently, and the connector is the one that decides).
 *
 * One client per write, opened and closed around it. A console writes a
 * handful of records a session, so an ordered socket held open between them
 * would buy nothing and keep a paid connection alive while nobody is writing.
 */
export class LiveRelayWritePort implements RelayWritePort {
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async send(packet: RelayWritePacket): Promise<RelayPacketOutcome> {
    const timeoutMs = packet.timeoutMs ?? this.#timeoutMs;
    let client: ToonClient | undefined;
    try {
      client = await ToonClient.create({
        connector: packet.payAt,
        evmPrivateKey: packet.keys.evm.privateKey,
        solanaSecretKey: packet.keys.solana.secretKey,
        chain: packet.chainKind,
        rpcUrl: packet.rpcUrl,
        channelStore: packet.channelStore,
        autoOpenChannel: false,
        transport: 'btp',
        timeoutMs,
      });
    } catch (error) {
      // Nothing was sent and nothing was signed: the client could not be
      // built. That is `refused`, not `unknown` — no packet exists to have an
      // unknown fate, and no record may be called published.
      return {
        kind: 'refused',
        code: 'CLIENT',
        refusedBy: 'edge',
        message: messageOf(error),
      };
    }

    try {
      const sent = await client.send(packet.destination, {
        // The relay's write surface takes `{ event }` as JSON and nothing else
        // (`POST /write`), exactly as the provider's publisher sends it.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: packet.event }),
      });
      if (sent.fulfilled) {
        return {
          kind: 'answered',
          status: sent.status,
          text: sent.text(),
          ...(sent.claim === undefined
            ? {}
            : { cost: sent.claim.amount.toString(), channelId: sent.claim.channelId }),
        };
      }
      return {
        kind: 'refused',
        code: sent.code,
        refusedBy: sent.refusedBy,
        message: sent.message,
        ...(sent.claim === undefined ? {} : { cost: sent.claim.amount.toString() }),
      };
    } catch (error) {
      // A throw here happened around the send rather than at the far end: a
      // socket that died, a deadline that passed. Whether the relay stored the
      // event is genuinely unknown, and a record must not be called published
      // on the strength of it.
      return { kind: 'unknown', message: messageOf(error) };
    } finally {
      // Flushes the channel store and releases the socket. It touches no
      // channel: what was signed stays signed.
      await client.close().catch(() => undefined);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
