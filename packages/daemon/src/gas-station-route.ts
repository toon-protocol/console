import { ToonClient, buildJobEvent, type GasStationReceipt } from '@toon-protocol/client';

import type { GasJobOutcome, GasJobPacket, GasJobPort } from './gas-station.js';

/**
 * The real paid job, behind `gas-station.ts`'s port (TOON_Network#119).
 *
 * Everything that opens a socket or signs a claim is here; the policy — which
 * chain can be bought for, which channel pays, which door to try, what a
 * refusal means — is next door where it can be tested without a connector, a
 * chain or a gas station. The same split as `relay-write-route.ts`, and the
 * same decisions, because it is the same kind of thing: one paid POST whose
 * price the connector quoted.
 *
 * **The job event is built by the client, and its key is thrown away.** A
 * NIP-90 job event's signature is INTEGRITY, not identity: it proves the
 * `param` tags were not altered between here and the handler, and the gas
 * station says so in as many words — who paid is the connector's proven
 * `X-TOON-Payer`, and no app takes an event pubkey for an authority. So
 * `buildJobEvent` mints 32 bytes, signs once and forgets them. That is a
 * privacy property worth having deliberately: the Account's Nostr identity
 * does not appear in a gas station's logs beside its Solana address, and no
 * remote signer is woken for a purchase.
 *
 * **It never names an amount.** The connector quoted the route's price in its
 * own `GET /ilp`, and the client pays that (TOON_Network#82). What the JOB
 * costs is the station's to say, in the quote this console shows before it
 * pays for an execute.
 *
 * **It seals past a hop only when told to.** `packet.sealTo` is the gas
 * station connector's own sealing key, read from that connector's `GET /ilp`,
 * and it is present exactly when this console pays at an edge that FORWARDS
 * the door rather than terminating it — the rule #121 established for a
 * forwarded relay write, applied to the other app behind the same hub.
 *
 * **It never opens a channel.** `autoOpenChannel: false`, deliberately: the
 * library's default is to open one on the first send, and an open locks
 * collateral on chain and pays that chain's gas — which is the very thing this
 * whole module exists because an account cannot do. `gas-station.ts` checks
 * for a channel first and refuses with somewhere to go.
 *
 * One client per packet, opened and closed around it. A purchase is two or
 * three packets a session, so an ordered socket held open between them would
 * buy nothing.
 */
export class LiveGasJobPort implements GasJobPort {
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    // Longer than a relay write's, because an execute is a chain round trip:
    // the station simulates, co-signs, broadcasts and waits for a
    // confirmation before it answers.
    this.#timeoutMs = options.timeoutMs ?? 90_000;
  }

  async send(packet: GasJobPacket): Promise<GasJobOutcome> {
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
        timeoutMs,
      });
    } catch (error) {
      // Nothing was sent and nothing was signed: the client could not be
      // built. That is `refused`, not `unknown` — no packet exists to have an
      // unknown fate, and no gas may be called bought.
      return { kind: 'refused', code: 'CLIENT', message: messageOf(error) };
    }

    try {
      const event = buildJobEvent({ kind: packet.kind, params: packet.params });
      const sent = await client.send(
        packet.destination,
        {
          // A gas station's door takes `{ event }` as JSON and nothing else,
          // exactly as every other NIP-90-over-ILP app in this fleet does.
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event }),
        },
        // No `amount`: the client pays what the route quoted (#82). `sealTo`
        // only when the edge being paid forwards rather than terminates.
        packet.sealTo === undefined ? undefined : { sealTo: packet.sealTo }
      );
      // The cost is read whatever the outcome, because a refusal is billed
      // (ADR 0003, #115) and a purchase that hid what it paid for a refusal
      // would be the silent loss #119 forbids.
      const cost = sent.claim?.amount.toString();

      if (!sent.fulfilled) {
        return {
          kind: 'refused',
          code: sent.code,
          message: sent.message,
          ...(cost === undefined ? {} : { cost }),
        };
      }

      const answer = decodeJobAnswer(sent.text());
      if (answer.kind === 'receipt') {
        // A receipt, whatever it says. A station that declined to spend has
        // ANSWERED — `status: 'failed'` with a reason is a successful job —
        // and telling that apart from a packet that never arrived is the
        // caller's whole business.
        return {
          kind: 'receipt',
          receipt: answer.receipt,
          ...(cost === undefined ? {} : { cost }),
          ...(sent.claim === undefined ? {} : { channelId: sent.claim.channelId }),
        };
      }
      return {
        kind: 'refused',
        code: answer.code,
        message: answer.message,
        ...(cost === undefined ? {} : { cost }),
      };
    } catch (error) {
      // A throw here happened around the send rather than at the far end: a
      // socket that died, a deadline that passed. Whether the station ran the
      // job is genuinely unknown, and it must not be called done or undone.
      return { kind: 'unknown', message: messageOf(error) };
    } finally {
      // Flushes the channel store and releases the socket. It touches no
      // channel: what was signed stays signed.
      await client.close().catch(() => undefined);
    }
  }
}

/**
 * The one decoding rule every NIP-90-over-ILP app in this protocol shares.
 *
 * The app answers `{ accept, result, data }`: `data` is `base64(JSON)` of the
 * receipt and is the byte-faithful one, `result` is the same thing already
 * decoded for readability, and `accept: false` is the app rejecting the EVENT
 * — a missing param, an unregistered kind — which rides home on a FULFILL and
 * so cost what a receipt would have cost.
 *
 * Written here rather than taken from the client's own `sendJob`, for one
 * reason: `sendJob` returns the receipt and drops the claim, and this console
 * must report what every packet cost, refusals included (#115). The rule is
 * the same rule, read off the same two fields, in the same preference order.
 */
export function decodeJobAnswer(
  text: string
):
  | { kind: 'receipt'; receipt: GasStationReceipt }
  | { kind: 'rejected'; code: string; message: string } {
  let envelope: Record<string, unknown>;
  try {
    envelope = asRecord(JSON.parse(text));
  } catch {
    return {
      kind: 'rejected',
      code: 'F00',
      message: `The gas station's answer was not JSON: ${text.slice(0, 200)}`,
    };
  }
  if (envelope['accept'] !== true) {
    return {
      kind: 'rejected',
      code: typeof envelope['code'] === 'string' ? envelope['code'] : 'F00',
      message:
        typeof envelope['message'] === 'string'
          ? envelope['message']
          : 'The gas station rejected the job event and said no more.',
    };
  }
  const data = envelope['data'];
  if (typeof data === 'string') {
    try {
      return {
        kind: 'receipt',
        receipt: JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as GasStationReceipt,
      };
    } catch {
      // Fall through to `result`: a receipt that would not decode from the
      // byte-faithful field is still worth reading from the readable one.
    }
  }
  const result = envelope['result'];
  if (typeof result === 'object' && result !== null) {
    return { kind: 'receipt', receipt: result as GasStationReceipt };
  }
  return {
    kind: 'rejected',
    code: 'F00',
    message: 'The gas station accepted the job and carried no receipt in `data` or `result`.',
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
