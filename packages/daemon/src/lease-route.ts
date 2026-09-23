import { ToonClient } from '@toon-protocol/client';

import { carriageRefusal } from './hidden-transport.js';
import { checkLeaseBody } from './lease-body.js';
import type { LeasePacket, PacketOutcome, ProviderPort } from './lease.js';

/**
 * The real paid route, behind `lease.ts`'s port.
 *
 * Everything that opens a socket or signs a claim is here, and the policy —
 * what a valid Lease Request looks like, when a vault record is taken back,
 * which connector collects — is next door where it can be tested without a
 * connector, a chain or a provider.
 *
 * Four things this does and no more.
 *
 * **It never opens a channel.** `autoOpenChannel: false`, deliberately: the
 * library's default is to open one on the first send, and an open locks
 * collateral on chain and pays the chain's own gas. Neither is a thing to do
 * to somebody who pressed "spawn". `lease.ts` checks for a channel before it
 * gets here and refuses with something to do about it.
 *
 * **It seals to the TERMINATING connector.** `sealTo` is the provider's pinned
 * `connector_seal_key` from its own Profile (§4.1, ADR 0011), which is the
 * only key that can open the payload — no hop may name that key on the
 * provider's behalf. When the packet is paid at the provider's own connector
 * the two are the same connector, and passing the key explicitly is still
 * right: it is the provider's Profile that says which key, not whoever
 * answered.
 *
 * **It checks the body's shape against the route's.** §5 has two shapes —
 * the §6.1 Lease Request envelope for the five routes that act on a lease
 * under the tenant's authority, and a bare `{ "workload_id": "…" }` for the
 * two extension routes, which present no Continuation Token because paying
 * them is their whole authority (ADR 0005, ADR 0025). A connector collects a
 * paid route's price before the provider app reads a byte, so the wrong shape
 * is `invalid_request` AFTER a full Lease Interval has been spent, with no
 * refund (ADR 0003, TOON_Network#115). `checkLeaseBody` is the standing check
 * that this console never bills a person for its own malformed request, and,
 * like `carriageRefusal`, it throws rather than sending.
 *
 * **A refusal is an outcome, not an error.** The client throws only for things
 * that happened before the packet left or on chain; a reject comes back as a
 * value. So this maps the client's three shapes onto the three `lease.ts`
 * distinguishes, and the distinction it must not blur is `refused` (definitive
 * — the vault record is taken back) against `unknown` (a fate nobody reported
 * — the record is kept, because a workload may be running behind it).
 *
 * **A Hidden Provider's packet carries `socksProxy` and NOTHING ELSE**
 * (TOON_Network#98, spec §10, ADR 0008). Handed that, the client builds the
 * whole carriage itself — the `fetch` behind its client edge, the undici
 * dispatcher behind viem's chain RPC, and the `ws` agent behind the BTP
 * carriage — which is what makes a websocket safe here where it was a leak for
 * the provider's publisher: there the proxy was installed as the process's own
 * `fetch`, which a websocket never passes through (`tools/publisher/proxy.mjs`,
 * `transportRefusal`). The trap that remains is the other direction, and it is
 * silent: the client resolves `config.fetch ?? transport.fetch`, so anything
 * injected here WINS and every request would leave this machine's own address
 * with the proxy sitting unused. `carriageRefusal` is the standing check that
 * it never does, and it throws rather than sending.
 */
export class LiveProviderPort implements ProviderPort {
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    // A spawn is a docker pull and a container start at the far end, so the
    // deadline is minutes rather than the library's 30 seconds.
    this.#timeoutMs = options.timeoutMs ?? 300_000;
  }

  async send(packet: LeasePacket): Promise<PacketOutcome> {
    const timeoutMs = packet.timeoutMs ?? this.#timeoutMs;
    // Before anything is built, and it throws rather than refusing: a packet
    // that would silently bypass the circuit is a bug in this repository, not
    // a condition a person can act on.
    const refusal = carriageRefusal({ socksProxy: packet.socksProxy });
    if (refusal !== null) throw new Error(refusal);
    // And the body's shape against the route's, for the same reason one step
    // along: a paid route bills for a refusal too, so a body this console
    // already knows is wrong must never become a signed claim
    // (TOON_Network#115, spec §5, ADR 0003, ADR 0025).
    checkLeaseBody(packet.route, packet.body);
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
        ...(packet.socksProxy === undefined ? {} : { socksProxy: packet.socksProxy }),
        ...(packet.proxyRpc === undefined ? {} : { proxyRpc: packet.proxyRpc }),
      });
    } catch (error) {
      // Nothing was sent and nothing was signed: the client could not be
      // built. That is `refused`, not `unknown` — no packet exists to have an
      // unknown fate.
      return {
        kind: 'refused',
        code: 'CLIENT',
        refusedBy: 'edge',
        message: messageOf(error),
      };
    }

    try {
      const sent = await client.send(
        packet.route,
        { body: packet.body as object },
        { sealTo: packet.sealTo, timeoutMs }
      );
      if (sent.fulfilled) {
        const text = sent.text();
        return {
          kind: 'answered',
          status: sent.status,
          body: parse(text),
          text,
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
      // socket that died, a deadline that passed. Whether the provider saw the
      // packet is genuinely unknown, and saying so is what keeps the Root
      // Secret of a lease that may be running.
      return { kind: 'unknown', message: messageOf(error) };
    } finally {
      // Flushes the channel store and releases the socket. It touches no
      // channel: what was signed stays signed.
      await client.close().catch(() => undefined);
    }
  }
}

/** The app's body, as JSON when it is JSON and as the raw text when it is not. */
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
