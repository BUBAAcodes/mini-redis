// Helpers shared by the bench scripts: a pipelined bulk loader, INFO fields, and container RSS.
//
// The loader writes SETs in batches and counts reply bytes instead of parsing replies: every
// SET answers `+OK\r\n` (5 bytes), so a million replies cost one integer add per chunk. The
// test-suite client parses each reply into a value, which is right for tests and far too slow
// for a million of them.
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const encode = (argv: readonly string[]): string =>
  `*${argv.length}\r\n` + argv.map((a) => `$${a.length}\r\n${a}\r\n`).join('');

export const key = (i: number): string => `key:${String(i).padStart(9, '0')}`;
export const value = (i: number, size: number): string =>
  String(i).padStart(size, 'v').slice(0, size);

/** Opens a connection and resolves once it's up. */
export function connect(port: number, host = '127.0.0.1'): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** Sends one command and resolves with its whole reply as text (enough for INFO, PING, SAVE). */
export async function call(port: number, ...argv: string[]): Promise<string> {
  const s = await connect(port);
  return new Promise((resolve, reject) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('latin1');
      const bulk = /^\$(\d+)\r\n/.exec(buf);
      const done = bulk ? buf.length >= bulk[0].length + Number(bulk[1]) + 2 : buf.endsWith('\r\n');
      if (done) {
        s.end();
        resolve(bulk ? buf.slice(bulk[0].length, bulk[0].length + Number(bulk[1])) : buf);
      }
    });
    s.on('error', reject);
    s.write(encode(argv));
  });
}

/** One `field:value` line out of INFO. */
export async function infoField(port: number, section: string, field: string): Promise<string> {
  const text = await call(port, 'INFO', section);
  const m = new RegExp(`^${field}:(.*)\r$`, 'm').exec(text);
  if (!m) throw new Error(`no ${field} in INFO ${section} on port ${port}`);
  return m[1]!;
}

/**
 * SETs `count` keys with `size`-byte values, `batch` commands per write, waiting for each
 * batch's replies before sending the next so neither side's buffers grow without bound.
 */
export async function fill(port: number, count: number, size = 100, batch = 10_000): Promise<void> {
  const s = await connect(port);
  let received = 0;
  let wake: (() => void) | null = null;
  s.on('data', (d) => {
    received += d.length;
    wake?.();
  });
  for (let start = 0; start < count; start += batch) {
    const end = Math.min(count, start + batch);
    let out = '';
    for (let i = start; i < end; i++) out += encode(['SET', key(i), value(i, size)]);
    s.write(Buffer.from(out, 'latin1'));
    const want = end * 5;
    while (received < want) await new Promise<void>((r) => (wake = r));
    if (received !== want) throw new Error(`unexpected reply bytes: ${received} for ${end} SETs`);
  }
  s.end();
}

/** RSS of a compose service's container, from `docker stats --no-stream`, in bytes. */
export function containerRss(service: string): number {
  const id = execFileSync('docker', ['compose', 'ps', '-q', service], { encoding: 'utf8' }).trim();
  const usage = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', id], {
    encoding: 'utf8',
  }).trim();
  return parseDockerSize(usage.split('/')[0]!.trim());
}

/** `12.5MiB`, `1.2GiB`, `800kB` → bytes. */
export function parseDockerSize(s: string): number {
  const m = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(s);
  if (!m) throw new Error(`can't read docker size '${s}'`);
  const units: Record<string, number> = {
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  return Number(m[1]) * units[m[2]!.toLowerCase()]!;
}

export const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
