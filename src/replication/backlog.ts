/**
 * The replication backlog (spec 9.13): the newest `repl-backlog-size` bytes of the replication
 * stream, with the offset of each, so a replica that lost its link for a moment can get back
 * exactly the bytes it missed (PSYNC → +CONTINUE) instead of a whole new snapshot.
 *
 * Key design choice: one fixed Buffer used as a ring. Appending copies the record in at the
 * write position and wraps; nothing is ever allocated per record, and the oldest bytes are
 * overwritten in place. Offsets count every byte the stream ever produced: `endOffset` is the
 * offset of the last byte written (the primary's master_repl_offset), and the backlog holds
 * offsets `firstByteOffset` … `endOffset`. A replica asking for offset `o` (the first byte it
 * doesn't have) can continue if `firstByteOffset ≤ o ≤ endOffset + 1`. It's created the first
 * time a replica needs it and never freed (docs/adr/0014-replication-backlog.md).
 *
 * Mirrors Redis replication.c (createReplicationBacklog, feedReplicationBacklog,
 * addReplyReplicationBacklog, resizeReplicationBacklog), before Redis 7 replaced the ring with
 * a shared list of reply blocks.
 */

export class ReplicationBacklog {
  private buf: Buffer;
  /** Where the next byte goes. */
  private idx = 0;
  private held = 0;
  private end: number;

  /** `offset` is the stream offset when it's created: its first byte will be `offset + 1`. */
  constructor(size: number, offset: number) {
    this.buf = Buffer.alloc(size);
    this.end = offset;
  }

  get size(): number {
    return this.buf.length;
  }

  /** Bytes held (INFO's repl_backlog_histlen). */
  get histlen(): number {
    return this.held;
  }

  /** Offset of the last byte written. */
  get endOffset(): number {
    return this.end;
  }

  /** Offset of the oldest byte held; `endOffset + 1` while empty, as in Redis. */
  get firstByteOffset(): number {
    return this.end - this.held + 1;
  }

  /** True if a replica whose next byte is `offset` can continue from here. */
  contains(offset: number): boolean {
    return offset >= this.firstByteOffset && offset <= this.end + 1;
  }

  /** Appends latin1 bytes (spec 7.1). A record longer than the ring leaves only its tail. */
  append(data: string): void {
    this.end += data.length;
    const size = this.buf.length;
    if (data.length >= size) {
      this.buf.write(data.slice(data.length - size), 0, 'latin1');
      this.idx = 0;
      this.held = size;
      return;
    }
    const first = Math.min(data.length, size - this.idx);
    this.buf.write(data.slice(0, first), this.idx, 'latin1');
    if (first < data.length) this.buf.write(data.slice(first), 0, 'latin1');
    this.idx = (this.idx + data.length) % size;
    this.held = Math.min(size, this.held + data.length);
  }

  /** A copy of the bytes from `offset` to the end. Throws if they aren't all held. */
  readFrom(offset: number): Buffer {
    if (!this.contains(offset)) {
      throw new RangeError(
        `offset ${offset} outside the backlog (${this.firstByteOffset}..${this.end + 1})`,
      );
    }
    const len = this.end + 1 - offset;
    const size = this.buf.length;
    const start = (this.idx - len + size) % size;
    if (start + len <= size) return Buffer.from(this.buf.subarray(start, start + len));
    return Buffer.concat([this.buf.subarray(start), this.buf.subarray(0, start + len - size)]);
  }

  /** CONFIG SET repl-backlog-size: keeps the newest bytes that fit in the new size. */
  resize(size: number): void {
    if (size === this.buf.length) return;
    const keep = Math.min(this.held, size);
    const kept = this.readFrom(this.end + 1 - keep);
    this.buf = Buffer.alloc(size);
    kept.copy(this.buf, 0);
    this.idx = keep % size;
    this.held = keep;
  }
}
