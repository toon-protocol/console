import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { GatewayNote } from './gateway.js';
import { accountWorkloadsPath, type ConsolePaths } from './paths.js';
import type { LeaseEnding, WorkloadStatus } from './workload.js';

/**
 * The last thing each provider said about each of this account's leases
 * (TOON_Network#93).
 *
 * A cache of a **free** read, which is what makes it uncontroversial: `status`
 * costs nothing at the provider (§5), so nothing here buys fidelity. What it
 * buys is that a dashboard opens with what it knew instead of a row of
 * question marks, and — the part that matters — that **an ending survives**. A
 * terminated lease is swept by the provider soon afterwards, and from then on
 * `status` answers `unknown_workload`; without this file the card would go
 * from "Ended — Termination" to "the provider has never heard of this lease"
 * on the next refresh, which is a worse answer to the same question.
 *
 * It holds no Root Secret, no Continuation Token and no key. It is a file on
 * disk like any other, so everything read out of it is checked for shape; a
 * lost or garbled one costs exactly one refresh.
 *
 * Keyed by ACCOUNT, beside the Chain Seed cache and the Lease Vault cache, for
 * the reason `paths.ts` gives: a lease belongs to the account that holds its
 * secret, and which network it was bought on is a field in its record.
 */

/** What one member of a Standby Set last said about the lease (§7). */
export interface WorkloadMemberNote {
  readonly status?: WorkloadStatus | undefined;
  readonly endedAs?: LeaseEnding | undefined;
  readonly expiresAt?: number | undefined;
}

/**
 * The Takeover this console has seen on a workload, kept so that "when" does
 * not become "just now" on every restart (§7.1, TOON_Network#95).
 *
 * `announcedAt` is the winner's own signed moment and needs no keeping; what
 * does is `firstSeenAt`, which is this console's observation and exists for
 * the case where no claim could be read at all. Neither is a secret, and
 * neither is worth a paid relay write — this is a local note about a public
 * event.
 */
export interface TakeoverNote {
  readonly winner: string;
  readonly from?: string | undefined;
  readonly rounds?: number | undefined;
  readonly announcedAt?: string | undefined;
  readonly firstSeenAt: string;
  readonly seenBy: 'status' | 'claim';
}

export interface WorkloadNote {
  /** The last answer, whatever kind it was. The PRIMARY's (§7's index 0). */
  readonly status?: WorkloadStatus | undefined;
  /** The last ending seen, kept after the provider stops knowing the lease. */
  readonly endedAs?: LeaseEnding | undefined;
  /** The last `expires_at` anything reported, unix seconds. */
  readonly expiresAt?: number | undefined;
  /**
   * The same, per member of the Standby Set, keyed by provider public key.
   *
   * A set's members answer different things about one workload — after a
   * Takeover the primary says `stopped` and the winner says `running` — so
   * one answer per workload was never enough for a set. The primary's is kept
   * in both places, because the fields above are where every console before
   * TOON_Network#95 looked.
   */
  readonly members?: Readonly<Record<string, WorkloadMemberNote>> | undefined;
  /** The Takeover seen on this workload, if one has been. */
  readonly takeover?: TakeoverNote | undefined;
  /**
   * What this console handed to a Workload Gateway, when it did
   * (TOON_Network#97).
   *
   * It lives here rather than in the Lease Vault because a handover is not a
   * fact about the lease: the lease is unchanged by it, the provider never
   * learns of it, and a second console signed in as the same account would be
   * right to hand the same workload to a gateway of its own. What it IS, is
   * this machine's record of which grant it should bear if asked to withdraw
   * — and it holds no grant, only the two inputs that derive one again.
   */
  readonly gateway?: GatewayNote | undefined;
  readonly at: string;
}

export interface WorkloadNoteStore {
  read(pubkey: string, workloadId: string): WorkloadNote | undefined;
  /**
   * Merges into whatever is held: a caller updates one field at a time.
   *
   * `members` merges BY MEMBER rather than replacing the map, so a write
   * about one provider never forgets what another said. That is the one
   * non-obvious thing about this store and the reason both implementations
   * below share the same merge.
   */
  write(
    pubkey: string,
    workloadId: string,
    note: Partial<WorkloadNote> & {
      members?: Readonly<Record<string, Partial<WorkloadMemberNote>>> | undefined;
    }
  ): void;
  remove(pubkey: string, workloadId: string): void;
}

/** One note merged into another, member by member. */
export function mergeNote(
  held: WorkloadNote | undefined,
  note: Partial<WorkloadNote> & {
    members?: Readonly<Record<string, Partial<WorkloadMemberNote>>> | undefined;
  },
  at: string
): WorkloadNote {
  const members: Record<string, WorkloadMemberNote> = { ...held?.members };
  for (const [pubkey, member] of Object.entries(note.members ?? {})) {
    members[pubkey] = { ...members[pubkey], ...member };
  }
  return {
    ...held,
    ...note,
    ...(Object.keys(members).length === 0 ? {} : { members }),
    at,
  };
}

interface NoteFile {
  readonly v: 1;
  readonly pubkey: string;
  readonly workloads: Record<string, WorkloadNote>;
}

export class FileWorkloadNoteStore implements WorkloadNoteStore {
  readonly #paths: ConsolePaths;
  readonly #now: () => Date;

  constructor(paths: ConsolePaths, now: () => Date = () => new Date()) {
    this.#paths = paths;
    this.#now = now;
  }

  read(pubkey: string, workloadId: string): WorkloadNote | undefined {
    return this.#load(pubkey)?.workloads[workloadId];
  }

  write(
    pubkey: string,
    workloadId: string,
    note: Partial<WorkloadNote> & {
      members?: Readonly<Record<string, Partial<WorkloadMemberNote>>> | undefined;
    }
  ): void {
    const file = this.#load(pubkey) ?? { v: 1 as const, pubkey, workloads: {} };
    const next = mergeNote(file.workloads[workloadId], note, this.#now().toISOString());
    this.#save({ ...file, workloads: { ...file.workloads, [workloadId]: next } });
  }

  remove(pubkey: string, workloadId: string): void {
    const file = this.#load(pubkey);
    if (file === undefined) return;
    const workloads = Object.fromEntries(
      Object.entries(file.workloads).filter(([id]) => id !== workloadId)
    );
    this.#save({ ...file, workloads });
  }

  #load(pubkey: string): NoteFile | undefined {
    const path = accountWorkloadsPath(this.#paths, pubkey);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    const file = parsed as Partial<NoteFile>;
    if (file.v !== 1 || file.pubkey !== pubkey || typeof file.workloads !== 'object') {
      return undefined;
    }
    const workloads: Record<string, WorkloadNote> = {};
    for (const [id, note] of Object.entries(file.workloads ?? {})) {
      if (typeof note === 'object' && note !== null && typeof note.at === 'string') {
        workloads[id] = note;
      }
    }
    return { v: 1, pubkey, workloads };
  }

  #save(file: NoteFile): void {
    const path = accountWorkloadsPath(this.#paths, file.pubkey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

/** For tests, and for a daemon that would rather forget on restart. */
export class InMemoryWorkloadNoteStore implements WorkloadNoteStore {
  readonly #held = new Map<string, WorkloadNote>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  read(pubkey: string, workloadId: string): WorkloadNote | undefined {
    return this.#held.get(`${pubkey}/${workloadId}`);
  }

  write(
    pubkey: string,
    workloadId: string,
    note: Partial<WorkloadNote> & {
      members?: Readonly<Record<string, Partial<WorkloadMemberNote>>> | undefined;
    }
  ): void {
    const key = `${pubkey}/${workloadId}`;
    this.#held.set(key, mergeNote(this.#held.get(key), note, this.#now().toISOString()));
  }

  remove(pubkey: string, workloadId: string): void {
    this.#held.delete(`${pubkey}/${workloadId}`);
  }
}
