import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

export interface WorkloadNote {
  /** The last answer, whatever kind it was. */
  readonly status?: WorkloadStatus | undefined;
  /** The last ending seen, kept after the provider stops knowing the lease. */
  readonly endedAs?: LeaseEnding | undefined;
  /** The last `expires_at` anything reported, unix seconds. */
  readonly expiresAt?: number | undefined;
  readonly at: string;
}

export interface WorkloadNoteStore {
  read(pubkey: string, workloadId: string): WorkloadNote | undefined;
  /** Merges into whatever is held: a caller updates one field at a time. */
  write(pubkey: string, workloadId: string, note: Partial<WorkloadNote>): void;
  remove(pubkey: string, workloadId: string): void;
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

  write(pubkey: string, workloadId: string, note: Partial<WorkloadNote>): void {
    const file = this.#load(pubkey) ?? { v: 1 as const, pubkey, workloads: {} };
    const held = file.workloads[workloadId];
    const next: WorkloadNote = {
      ...held,
      ...note,
      at: this.#now().toISOString(),
    };
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

  write(pubkey: string, workloadId: string, note: Partial<WorkloadNote>): void {
    const key = `${pubkey}/${workloadId}`;
    this.#held.set(key, {
      ...this.#held.get(key),
      ...note,
      at: this.#now().toISOString(),
    });
  }

  remove(pubkey: string, workloadId: string): void {
    this.#held.delete(`${pubkey}/${workloadId}`);
  }
}
