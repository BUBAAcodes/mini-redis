// A fake replica on a raw socket (spec 9.13), for testing the primary side before a real replica
// exists: it runs the handshake, reads +FULLRESYNC or +CONTINUE, the `$<len>` payload (skipping
// the primary's keepalive newlines), and then collects the stream byte for byte, so a test can
// compare exact bytes and offsets. Everything is latin1, one char per byte (spec 7.1).
import net from 'node:net';
import { expect } from 'vitest';
import { encodeCommand } from './resp-client.js';

export type SyncReply =
  { kind: 'full'; replid: string; offset: number } | { kind: 'continue'; replid: string | null };

export class FakeReplica {
  /** Bytes received and not yet consumed by the handshake readers. */
  private buf = Buffer.alloc(0);
  private ended = false;
  private wake: (() => void) | null = null;
  readonly closed: Promise<void>;
  /** The snapshot payload of a full sync. */
  payload: Buffer | null = null;
  /** Newlines the primary sent before the payload (keepalives). */
  newlines = 0;
  /** True once the sync reply (and any payload) was read: later bytes are the stream. */
  private streaming = false;
  /** Every stream byte received since streaming started. */
  stream = '';
  /** Offset of the byte before the stream's first one (FULLRESYNC's offset, or PSYNC's - 1). */
  startOffset = 0;

  private constructor(readonly socket: net.Socket) {
    socket.on('data', (d: Buffer) => {
      if (this.streaming) this.stream += d.toString('latin1');
      else this.buf = Buffer.concat([this.buf, d]);
      this.notify();
    });
    socket.on('error', () => {});
    this.closed = new Promise((resolve) =>
      socket.on('close', () => {
        this.ended = true;
        this.notify();
        resolve();
      }),
    );
  }

  static connect(port: number): Promise<FakeReplica> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => resolve(new FakeReplica(socket)));
      socket.once('error', reject);
    });
  }

  /** Connects and runs the handshake up to PSYNC (spec 9.13 steps 1, 3, 4). */
  static async handshake(
    port: number,
    { listeningPort = 7000, psync2 = true }: { listeningPort?: number; psync2?: boolean } = {},
  ): Promise<FakeReplica> {
    const r = await FakeReplica.connect(port);
    expect(await r.command('PING')).toBe('+PONG');
    expect(await r.command('REPLCONF', 'listening-port', String(listeningPort))).toBe('+OK');
    if (psync2) expect(await r.command('REPLCONF', 'capa', 'psync2')).toBe('+OK');
    return r;
  }

  /** Connects, shakes hands and full-syncs: the replica is online when this resolves. */
  static async synced(port: number, listeningPort = 7000): Promise<FakeReplica> {
    const r = await FakeReplica.handshake(port, { listeningPort });
    const reply = await r.psync('?', -1);
    expect(reply.kind).toBe('full');
    return r;
  }

  send(...argv: string[]): void {
    this.socket.write(Buffer.from(encodeCommand(argv), 'latin1'));
  }

  /** Sends a command and reads its one-line reply, e.g. '+OK'. */
  async command(...argv: string[]): Promise<string> {
    this.send(...argv);
    return this.readLine();
  }

  /**
   * PSYNC, then the reply line; for a full sync also the payload. Afterwards every byte goes to
   * `stream`.
   */
  async psync(replid: string, offset: number): Promise<SyncReply> {
    this.send('PSYNC', replid, String(offset));
    const line = await this.readLine();
    let reply: SyncReply;
    const full = /^\+FULLRESYNC ([0-9a-f]{40}) (\d+)$/.exec(line);
    if (full !== null) {
      reply = { kind: 'full', replid: full[1]!, offset: Number(full[2]) };
      this.startOffset = reply.offset;
      const header = await this.readLine();
      const m = /^\$(\d+)$/.exec(header);
      if (m === null) throw new Error(`expected $<len>, got ${JSON.stringify(header)}`);
      this.payload = await this.readBytes(Number(m[1]));
    } else {
      const cont = /^\+CONTINUE(?: ([0-9a-f]{40}))?$/.exec(line);
      if (cont === null) throw new Error(`unexpected PSYNC reply ${JSON.stringify(line)}`);
      reply = { kind: 'continue', replid: cont[1] ?? null };
      this.startOffset = offset - 1;
    }
    this.streaming = true;
    this.stream = this.buf.toString('latin1');
    this.buf = Buffer.alloc(0);
    return reply;
  }

  /** The replication offset of the last stream byte received. */
  get offset(): number {
    return this.startOffset + this.stream.length;
  }

  ack(offset: number = this.offset): void {
    this.send('REPLCONF', 'ACK', String(offset));
  }

  /** Waits until `stream` satisfies `done` (or the connection closes). */
  async waitStream(done: (stream: string) => boolean, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!done(this.stream)) {
      if (this.ended) throw new Error(`closed; stream so far: ${JSON.stringify(this.stream)}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; stream so far: ${JSON.stringify(this.stream)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
    return this.stream;
  }

  /** Waits until the stream holds at least `offset`'s byte. */
  waitOffset(offset: number, timeoutMs?: number): Promise<string> {
    return this.waitStream(() => this.offset >= offset, timeoutMs);
  }

  close(): Promise<void> {
    this.socket.destroy();
    return this.closed;
  }

  /** One `\r\n`-terminated line, skipping the bare `\n` keepalives in front of it. */
  private async readLine(): Promise<string> {
    for (;;) {
      while (this.buf.length > 0 && this.buf[0] === 0x0a) {
        this.newlines++;
        this.buf = this.buf.subarray(1);
      }
      const end = this.buf.indexOf('\r\n');
      if (end !== -1) {
        const line = this.buf.subarray(0, end).toString('latin1');
        this.buf = this.buf.subarray(end + 2);
        return line;
      }
      await this.more();
    }
  }

  private async readBytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.more();
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  private async more(): Promise<void> {
    if (this.ended)
      throw new Error(`connection closed; unread: ${JSON.stringify(String(this.buf))}`);
    await new Promise<void>((resolve) => (this.wake = resolve));
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
