// A fake primary on a raw socket (spec 9.13), for testing the replica side byte for byte: it
// accepts the replica's connections, parses the commands the replica sends (the handshake,
// ACKs), and writes whatever a test asks for: replies, keepalive newlines, a `$<len>` payload,
// stream bytes split any way. Everything is latin1, one char per byte (spec 7.1).
import net from 'node:net';
import { RespParser } from '../../src/protocol/parser.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `$<len>\r\n` and the bytes, as a primary sends a full-sync payload (no trailing CRLF). */
export const payloadFrame = (payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from(`$${payload.length}\r\n`, 'latin1'), payload]);

export class FakeLink {
  private readonly parser = new RespParser();
  private readonly received: string[][] = [];
  private wake: (() => void) | null = null;
  ended = false;
  readonly closed: Promise<void>;

  constructor(readonly socket: net.Socket) {
    socket.on('data', (d: Buffer) => {
      this.parser.feed(d);
      for (let cmd = this.parser.next(); cmd !== null; cmd = this.parser.next()) {
        this.received.push([...cmd.argv]);
      }
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

  write(data: string | Buffer): void {
    this.socket.write(typeof data === 'string' ? Buffer.from(data, 'latin1') : data);
  }

  /** The next command the replica sent. */
  async next(timeoutMs = 5000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.length === 0) {
      if (this.ended) throw new Error('the replica closed the link');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a command from the replica');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
    return this.received.shift()!;
  }

  /** The next command that isn't a periodic `REPLCONF ACK`. */
  async nextNonAck(timeoutMs = 5000): Promise<string[]> {
    for (;;) {
      const argv = await this.next(timeoutMs);
      if (!(argv[0]?.toUpperCase() === 'REPLCONF' && argv[1]?.toUpperCase() === 'ACK')) {
        return argv;
      }
    }
  }

  /** The next `REPLCONF ACK <offset>`'s offset. */
  async nextAck(timeoutMs = 5000): Promise<number> {
    for (;;) {
      const argv = await this.next(timeoutMs);
      if (argv[0]?.toUpperCase() === 'REPLCONF' && argv[1]?.toUpperCase() === 'ACK') {
        return Number(argv[2]);
      }
    }
  }

  /** Waits until the replica sends an ACK of at least `offset`. */
  async ackReaching(offset: number, timeoutMs = 5000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const acked = await this.nextAck(Math.max(deadline - Date.now(), 1));
      if (acked >= offset) return acked;
    }
  }

  /**
   * Answers the handshake (spec 9.13 steps 1–4) and returns the commands it saw, PSYNC last.
   * `auth` expects an AUTH between PING and the REPLCONFs.
   */
  async handshake({ auth = false } = {}): Promise<string[][]> {
    const seen: string[][] = [];
    const expectCmd = async (name: string, reply: string): Promise<void> => {
      const argv = await this.nextNonAck();
      seen.push(argv);
      if (argv[0]!.toUpperCase() !== name) {
        throw new Error(`expected ${name}, got ${JSON.stringify(argv)}`);
      }
      if (reply !== '') this.write(reply);
    };
    await expectCmd('PING', '+PONG\r\n');
    if (auth) await expectCmd('AUTH', '+OK\r\n');
    await expectCmd('REPLCONF', '+OK\r\n');
    await expectCmd('REPLCONF', '+OK\r\n');
    await expectCmd('PSYNC', '');
    return seen;
  }

  /** `+FULLRESYNC`, then the payload: the replica loads it and starts streaming. */
  fullSync(replid: string, offset: number, payload: Buffer): void {
    this.write(`+FULLRESYNC ${replid} ${offset}\r\n`);
    this.write(payloadFrame(payload));
  }

  close(): Promise<void> {
    this.socket.destroy();
    return this.closed;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

export class FakePrimary {
  private readonly accepted: FakeLink[] = [];
  private wake: (() => void) | null = null;
  readonly links: FakeLink[] = [];

  private constructor(
    private readonly listener: net.Server,
    readonly port: number,
  ) {
    listener.on('connection', (socket) => {
      const link = new FakeLink(socket);
      this.links.push(link);
      this.accepted.push(link);
      const wake = this.wake;
      this.wake = null;
      wake?.();
    });
  }

  static start(): Promise<FakePrimary> {
    const listener = net.createServer();
    return new Promise((resolve) => {
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address() as net.AddressInfo;
        resolve(new FakePrimary(listener, address.port));
      });
    });
  }

  /** The replica's next connection. */
  async accept(timeoutMs = 5000): Promise<FakeLink> {
    const deadline = Date.now() + timeoutMs;
    while (this.accepted.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for the replica to connect');
      await Promise.race([new Promise<void>((resolve) => (this.wake = resolve)), sleep(left)]);
    }
    return this.accepted.shift()!;
  }

  async close(): Promise<void> {
    for (const link of this.links) link.socket.destroy();
    await new Promise<void>((resolve) => this.listener.close(() => resolve()));
  }
}
