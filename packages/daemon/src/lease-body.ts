/**
 * **The two request-body shapes spec §5 has, and the check that a paid packet
 * carries the right one before money moves** (TOON_Network#115, ADR 0025).
 *
 * Five routes act on a lease under the tenant's authority — `.spawn`,
 * `.standby`, `.status`, `.terminate`, `.rotate` — and take the §6.1 Lease
 * Request envelope, `{ "request": { … } }`, because that envelope is the
 * Continuation Token's carriage. The two extension routes take their content
 * **bare**, `{ "workload_id": "…" }`, because an extension presents no token
 * at all: paying the route is its whole authority, and any payer may extend
 * any lease (§6.3, ADR 0005).
 *
 * **The asymmetry is deliberate and it costs money to get wrong.** A connector
 * collects a paid route's price before the provider app reads a byte of the
 * body (ADR 0003), so an extension wrapped like its neighbours is
 * `invalid_request` — *after* a full Lease Interval has been spent, with no
 * refund. That is how #115 was found on the live devnet: a lease that should
 * have cost 2000 µUSDC cost 3000. A console that billed a person for its own
 * malformed request would be indefensible, so this is the standing check that
 * it cannot.
 *
 * **It throws.** Like `carriageRefusal` in `hidden-transport.ts`, a mismatch
 * here is a bug in this repository rather than a condition a person can act
 * on: nothing a person types chooses a body shape. `lease-route.ts` runs it
 * before the client is even built, so the refusal provably precedes the signed
 * claim.
 *
 * Pure on purpose — no client, no connector, no keys — so the rule is tested
 * without any of them.
 */

/** A body this console refused to send. Thrown BEFORE the packet, which is the point. */
export class LeaseBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseBodyError';
  }
}

/** The five routes whose body is the §6.1 Lease Request envelope. */
const ENVELOPE = /\.(spawn|standby|status|terminate|rotate)$/;
/** The two routes whose body is bare: `<addr>.<listing>.v<n>.extend` and `.standby.extend`. */
const BARE = /\.(standby\.)?extend$/;

const HEX_32 = /^[0-9a-f]{64}$/;

/**
 * The body an extension takes: bare, one key, no Lease Request (§6.3).
 *
 * Built rather than remembered. Every `.extend` and `.standby.extend` body
 * this console sends comes from here, so there is one place for the shape to
 * be right and none for it to drift.
 */
export function extendBody(workloadId: string): { workload_id: string } {
  if (!HEX_32.test(workloadId))
    throw new LeaseBodyError(
      `An extension names its workload as 64 lowercase hex characters, and this is ${JSON.stringify(workloadId)}.`
    );
  return { workload_id: workloadId };
}

/**
 * The check every lease packet passes before it leaves. Returns the body, so
 * it reads as the last thing that happens to it.
 *
 * A route this console sends to that is none of §5's is left alone: a relay
 * write is not a lease packet and has no business being judged here.
 */
export function checkLeaseBody<T>(route: string, body: T): T {
  const shape =
    body === null || typeof body !== 'object'
      ? 'nothing'
      : 'request' in body
        ? 'a Lease Request envelope'
        : 'workload_id' in body
          ? 'a bare workload id'
          : 'something else';

  if (BARE.test(route)) {
    if (shape !== 'a bare workload id')
      throw new LeaseBodyError(
        `${route} takes a BARE { "workload_id": "…" } and was handed ${shape}. An extension ` +
          `carries no Lease Request, because paying the route is its authority (§6.3, ADR 0025), ` +
          `and the envelope here is \`invalid_request\` AT THE ROUTE'S FULL PRICE (ADR 0003). ` +
          `Nothing was sent.`
      );
    return body;
  }

  if (ENVELOPE.test(route) && shape !== 'a Lease Request envelope')
    throw new LeaseBodyError(
      `${route} takes { "request": <Lease Request> } and was handed ${shape}. §6.1 refuses a ` +
        `body with any other key as \`invalid_request\`, and on a paid route that refusal is ` +
        `billed. Nothing was sent.`
    );

  return body;
}
