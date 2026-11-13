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
 * Mirrors Redis server.c (call, alsoPropagate, propagatePendingCommands,
 * preventCommandPropagation).
 */

export interface PropagationRecord {
  readonly db: number;
  readonly argv: readonly string[];
}

export interface PropagationSink {
  append(record: PropagationRecord): void;
}

export class Propagator {
  private readonly sinks = new Set<PropagationSink>();
  private also: PropagationRecord[] = [];
  private rewritten: readonly string[] | null = null;
  private prevented = false;

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

  alsoPropagate(db: number, argv: readonly string[]): void {
    this.also.push({ db, argv });
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

  private emit(record: PropagationRecord): void {
    if (this.sinks.size === 0) return;
    for (const sink of this.sinks) sink.append(record);
    this.wake();
  }
}
