// A raw RESP client for tests: sends commands as multibulk (or any raw bytes) and reads replies
// either decoded or as their exact bytes, so tests can assert Redis-exact output (rule 3).
// Everything is latin1, one char per byte (spec 7.1).
import net from 'node:net';

export class RespError {
  constructor(readonly message: string) {}
}

export type RespValue =
  string | number | bigint | boolean | null | RespError | RespValue[] | Map<RespValue, RespValue>;

class Incomplete extends Error {}

/** Parses one reply starting at `pos`; throws Incomplete if more bytes are needed. */
function parseReply(buf: string, pos: number): [RespValue, number] {
  const lineEnd = buf.indexOf('\r\n', pos);
  if (lineEnd === -1) throw new Incomplete();
  const type = buf[pos];
  const line = buf.slice(pos + 1, lineEnd);
  let next = lineEnd + 2;
  const bulk = (): [string, number] => {
    const len = Number(line);
    if (buf.length < next + len + 2) throw new Incomplete();
    return [buf.slice(next, next + len), next + len + 2];
  };
  const items = (n: number): [RespValue[], number] => {
    const out: RespValue[] = [];
    for (let i = 0; i < n; i++) {
      const [v, end] = parseReply(buf, next);
      out.push(v);
      next = end;
    }
    return [out, next];
  };
  switch (type) {
    case '+':
      return [line, next];
    case '-':
      return [new RespError(line), next];
    case ':': {
      const n = BigInt(line);
      return [
        n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(n)
          : n,
        next,
      ];
    }
    case '$':
      return line === '-1' ? [null, next] : bulk();
    case '*':
      return line === '-1' ? [null, next] : items(Number(line));
    case '_':
      return [null, next];
    case ',':
      return [Number(line.replace(/^(-?)inf$/, '$1Infinity')), next];
    case '#':
      return [line === 't', next];
    case '=': {
      const [s, end] = bulk();
      return [s.slice(4), end]; // drop the "txt:" format prefix
    }
    case '~':
    case '>':
      return items(Number(line));
    case '%': {
      const [flat, end] = items(Number(line) * 2);
      const map = new Map<RespValue, RespValue>();
      for (let i = 0; i < flat.length; i += 2) map.set(flat[i]!, flat[i + 1]!);
      return [map, end];
    }
    default:
      throw new Error(`unexpected reply type ${JSON.stringify(type)} in ${JSON.stringify(buf)}`);
  }
}

export const encodeCommand = (argv: readonly string[]): string =>
  `*${argv.length}\r\n` + argv.map((a) => `$${a.length}\r\n${a}\r\n`).join('');

export class TestClient {
  private buf = '';
  private ended = false;
  private wake: (() => void) | null = null;
  readonly closed: Promise<void>;

  private constructor(readonly socket: net.Socket) {
    socket.on('data', (d) => {
      this.buf += d.toString('latin1');
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

  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => resolve(new TestClient(socket)));
      socket.once('error', reject);
    });
  }

  /** Raw bytes, as given (strings are latin1). */
  write(data: string | Buffer): void {
    this.socket.write(typeof data === 'string' ? Buffer.from(data, 'latin1') : data);
  }

  send(...argv: string[]): void {
    this.write(encodeCommand(argv));
  }

  /** The next reply, decoded. */
  async read(): Promise<RespValue> {
    const [value] = await this.next();
    return value;
  }

  /** The next reply, as its exact bytes. */
  async readRaw(): Promise<string> {
    const [, raw] = await this.next();
    return raw;
  }

  async call(...argv: string[]): Promise<RespValue> {
    this.send(...argv);
    return this.read();
  }

  async raw(...argv: string[]): Promise<string> {
    this.send(...argv);
    return this.readRaw();
  }

  /** Everything received so far that hasn't been read as a reply. */
  get unread(): string {
    return this.buf;
  }

  async close(): Promise<void> {
    this.socket.end();
    await this.closed;
  }

  private async next(): Promise<[RespValue, string]> {
    for (;;) {
      try {
        const [value, end] = parseReply(this.buf, 0);
        const raw = this.buf.slice(0, end);
        this.buf = this.buf.slice(end);
        return [value, raw];
      } catch (e) {
        if (!(e instanceof Incomplete)) throw e;
      }
      if (this.ended) throw new Error(`connection closed; unread: ${JSON.stringify(this.buf)}`);
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
