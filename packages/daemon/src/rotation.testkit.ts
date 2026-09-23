import type { LeasePacket, PacketOutcome } from './lease.js';
import { RotationStore } from './rotation.js';
import type { LeaseVault } from './lease-vault.js';
import type { MemberOpPort } from './workload.js';

/**
 * A rotation over fakes (TOON_Network#96).
 *
 * Every case this ticket turns on is a provider behaving in a way no live one
 * can be asked to behave on demand: answering `unavailable` because its disk
 * would not take the write (TOON_Network#78), taking a rotate and then going
 * silent before the answer, or answering `not_tenant` because an earlier run's
 * rotate landed after all. Each of those decides something different about
 * what a person is told, and one of them — `unavailable` — decides whether
 * they believe a leaked token is dead.
 *
 * What is NOT faked is the derivation. The tests read the tokens out of the
 * bodies the fake was handed and check them against §6.1.1's own arithmetic
 * over the vault's real root secrets, so "the request presents the token this
 * member holds and names the one derived from the NEW root" is checked against
 * the spec rather than against this file.
 */

/** §6.8's answer to a rotation that took: no token in it, old or new. */
export function rotatedOk(packet: LeasePacket): PacketOutcome {
  const body = packet.body as { request: { content: { workload_id: string } } };
  const answer = { workload_id: body.request.content.workload_id, rotated: true };
  return { kind: 'answered', status: 200, body: answer, text: JSON.stringify(answer) };
}

/**
 * §6.8 step 7: the provider could not persist, so it restored the token it
 * found in memory and refused. Nothing changed and the old token still works.
 *
 * 503, because that is what the reference provider answers for `unavailable`
 * alone — and, as everywhere, the status is not what anything reads (§5).
 */
export function unavailable(message = 'the lease could not be saved'): PacketOutcome {
  const body = { error: 'unavailable', message };
  return { kind: 'answered', status: 503, body, text: JSON.stringify(body) };
}

/**
 * An answer per route, so one fake can play a whole rotation.
 *
 * Keyed on the last segment of the destination — `rotate` or `status` — which
 * is what §6.8's recovery turns on: the rotate's answer is lost, and the
 * `status` that follows is the one that settles which token holds the lease.
 */
export function byRoute(answers: {
  rotate: PacketOutcome | ((packet: LeasePacket) => PacketOutcome);
  status: PacketOutcome | ((packet: LeasePacket) => PacketOutcome);
}): (packet: LeasePacket) => PacketOutcome {
  return (packet) => {
    const given = packet.route.endsWith('.rotate') ? answers.rotate : answers.status;
    return typeof given === 'function' ? given(packet) : given;
  };
}

export function rotationFixture(input: {
  vault: LeaseVault;
  ops: MemberOpPort;
  now?: () => Date;
}): RotationStore {
  return new RotationStore({
    vault: input.vault,
    ops: input.ops,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
