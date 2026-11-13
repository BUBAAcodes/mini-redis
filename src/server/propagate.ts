/**
 * Propagation (spec 9.5, rule 6): the one path from a write to the AOF and the replicas.
 *
 * Key design choice: sinks (the AOF in step 12, the replication stream in step 20) attach here
 * and receive exact `{ db, argv }` records in the order changes happened; none are attached
 * yet, and tests attach a recording sink. A handler shapes its own record through three
 * helpers: rewritePropagation() replaces it (SET … EX → SET … PXAT), alsoPropagate() emits
 * other records instead of it (SPOP → SREM), and preventPropagation() drops it. Spec 9.5 lists
 * all three as "unless", so alsoPropagate() replaces the command as it arrived; that differs
 * from Redis, where the handler must also call preventCommandPropagation(). Each sink adds
 * SELECT itself when a record's db differs from the last one it wrote.
 *
 * During EXEC (multiStart … multiEnd) records are held back and then sent as `MULTI`, the
 * records, `EXEC`, so a replay applies the transaction atomically. Lazy-expiry DELs found
 * inside EXEC go inside too. MULTI takes the first record's db and EXEC the last one's, so no
 * sink needs a SELECT just for them. Spec 9.5 wraps every EXEC that wrote anything; Redis 7
 * skips the wrapper when there is only one record (docs/DIFFERENCES.md).
 *
 * A record marked `replicasOnly` (PUBLISH, spec 9.5) is data-less: the replication sink sends it
 * and the AOF sink must skip it, because the AOF stores data, not messages. The marker lives on
 * the record rather than in a second path so ordering against other records stays exact.
 *
 * Mirrors Redis server.c (call, alsoPropagate, propagatePendingCommands,
 * preventCommandPropagation, forceCommandPropagation with PROPAGATE_REPL).
 */

export interface PropagationRecord {
  readonly db: number;
  readonly argv: readonly string[];
  /** For replicas only: the AOF sink skips it. Absent means both sinks. */
  readonly replicasOnly?: true;
}

export interface PropagationSink {
  append(record: PropagationRecord): void;
}

export class Propagator {
  private readonly sinks = new Set<PropagationSink>();
  private also: PropagationRecord[] = [];
  private rewritten: readonly string[] | null = null;
  private prevented = false;
  /** Records held back while an EXEC runs; null outside one. */
  private transaction: PropagationRecord[] | null = null;

  /** `wake` runs whenever a record goes out, so beforeSleep writes it this loop turn. */
  constructor(private readonly wake: () => void) {}

  /** Adds a sink; returns the function that detaches it. */
  attach(sink: PropagationSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /** Clears the per-command state; the dispatcher calls it before every handler. */
  begin(): void {
    this.also = [];
    this.rewritten = null;
    this.prevented = false;
  }

  rewrite(argv: readonly string[]): void {
    this.rewritten = argv;
  }

  alsoPropagate(db: number, argv: readonly string[], replicasOnly = false): void {
    this.also.push(replicasOnly ? { db, argv, replicasOnly: true } : { db, argv });
  }

  prevent(): void {
    this.prevented = true;
  }

  /**
   * Emits a record at once, ahead of the running command's own: a lazy-expiry DEL found during
   * a command (step 7) must replay before the command that found it.
   */
  propagateNow(db: number, argv: readonly string[]): void {
    this.emit({ db, argv });
  }

  /**
   * After the handler. `changed` is true for a `write` command that grew `server.dirty`: only
   * those propagate their own (or rewritten) record. Records from alsoPropagate() always go.
   */
  end(db: number, argv: readonly string[], changed: boolean): void {
    if (this.also.length > 0) {
      for (const record of this.also) this.emit(record);
    } else if (changed && !this.prevented) {
      this.emit({ db, argv: this.rewritten ?? argv });
    }
    this.begin();
  }

  /** EXEC is about to run its queue: hold its records back. */
  multiStart(): void {
    this.transaction = [];
  }

  /** EXEC finished: send what it wrote, wrapped in MULTI … EXEC, or nothing if it wrote nothing. */
  multiEnd(): void {
    const records = this.transaction;
    this.transaction = null;
    if (records === null || records.length === 0) return;
    this.emit({ db: records[0]!.db, argv: ['MULTI'] });
    for (const record of records) this.emit(record);
    this.emit({ db: records[records.length - 1]!.db, argv: ['EXEC'] });
  }

  private emit(record: PropagationRecord): void {
    if (this.sinks.size === 0) return;
    if (this.transaction !== null) {
      this.transaction.push(record);
      return;
    }
    for (const sink of this.sinks) sink.append(record);
    this.wake();
  }
}
