/**
 * Configuration (spec 5): the directive table with defaults, the config file and `--flag`
 * parsers, memory units, and the machinery behind CONFIG GET and CONFIG SET.
 *
 * Key design choice: one table holds every directive's default (as the string a user would
 * write), whether CONFIG SET may change it, a parser and a formatter. Defaults, the config file,
 * flags and CONFIG SET all go through the same parser, so they can't disagree on what a value
 * means, and CONFIG SET parses every pair before it changes anything (rule 4).
 *
 * Mirrors Redis config.c (standardConfig, loadServerConfigFromString, configSetCommand,
 * configGetCommand, memtoull).
 */
import { constants as bufferConstants } from 'node:buffer';
import { ERR, ReplyError } from './protocol/errors.js';
import { ProtocolError } from './protocol/errors.js';
import { splitArgs } from './protocol/parser.js';
import { hasGlobChars, stringMatch } from './utils/glob.js';
import { LOG_LEVELS } from './utils/logger.js';
import type { LogLevel } from './utils/logger.js';
import { parseInt64 } from './utils/numbers.js';

export const EVICTION_POLICIES = [
  'volatile-lru',
  'volatile-lfu',
  'volatile-random',
  'volatile-ttl',
  'allkeys-lru',
  'allkeys-lfu',
  'allkeys-random',
  'noeviction',
] as const;
export type EvictionPolicy = (typeof EVICTION_POLICIES)[number];

export const FSYNC_POLICIES = ['everysec', 'always', 'no'] as const;
export type FsyncPolicy = (typeof FSYNC_POLICIES)[number];

export interface SavePoint {
  seconds: number;
  changes: number;
}

export interface OutputLimit {
  hard: number;
  soft: number;
  softSeconds: number;
}

export interface OutputLimits {
  normal: OutputLimit;
  replica: OutputLimit;
  pubsub: OutputLimit;
}

export interface ReplicaOf {
  host: string;
  port: number;
}

export interface ConfigValues {
  port: number;
  bind: string;
  requirepass: string;
  databases: number;
  maxclients: number;
  timeout: number;
  'tcp-keepalive': number;
  hz: number;
  loglevel: LogLevel;
  dir: string;
  dbfilename: string;
  save: SavePoint[];
  appendonly: boolean;
  appendfilename: string;
  appendfsync: FsyncPolicy;
  'aof-load-truncated': boolean;
  'auto-aof-rewrite-percentage': number;
  'auto-aof-rewrite-min-size': number;
  maxmemory: number;
  'maxmemory-policy': EvictionPolicy;
  'maxmemory-samples': number;
  'lfu-log-factor': number;
  'lfu-decay-time': number;
  'list-max-node-items': number;
  'proto-max-bulk-len': number;
  'client-query-buffer-limit': number;
  'client-output-buffer-limit': OutputLimits;
  'slowlog-log-slower-than': number;
  'slowlog-max-len': number;
  replicaof: ReplicaOf | null;
  masterauth: string;
  'replica-read-only': boolean;
  'repl-backlog-size': number;
  'repl-timeout': number;
  'repl-ping-replica-period': number;
  'enable-debug-command': boolean;
  'metrics-port': number;
}

export type ConfigName = keyof ConfigValues;

/** A bad config file line or flag: Redis prints all three parts, then exits. */
export class ConfigError extends Error {
  override name = 'ConfigError';
  constructor(
    readonly where: string,
    readonly line: string,
    readonly reason: string,
  ) {
    super(`${where}: '${line}': ${reason}`);
  }
}

/** One directive from a config file line or a flag: `args[0]` is its name. */
export interface DirectiveLine {
  args: string[];
  /** "at line 3" or "from the command line", for error messages. */
  where: string;
  /** The text as the user wrote it, quoted back in errors. */
  line: string;
}

/** Thrown by a directive's parser; the caller adds where it happened. */
class InvalidValue extends Error {}

interface DirectiveSpec<T> {
  default: string;
  mutable: boolean;
  /** Takes several words (`save 3600 1 300 100`); file and flag args are joined with spaces. */
  multiWord?: boolean;
  /**
   * `current` lets a directive update only part of its value, as client-output-buffer-limit
   * does; it's undefined while the defaults themselves are parsed.
   */
  parse(raw: string, current: T | undefined): T;
  format(value: T): string;
}

const INT_MAX = 2n ** 31n - 1n;
const UINT_MAX = 2n ** 32n - 1n;
const LLONG_MAX = 2n ** 63n - 1n;
const ULLONG_MAX = 2n ** 64n - 1n;
const MB = 1024n * 1024n;

const UNITS: Record<string, bigint> = {
  '': 1n,
  b: 1n,
  k: 1000n,
  kb: 1024n,
  m: 1000n * 1000n,
  mb: MB,
  g: 1000n * 1000n * 1000n,
  gb: 1024n * MB,
};

/** memtoull(): digits, then an optional unit in any case. */
function parseMemoryBig(s: string): bigint | null {
  const m = /^([0-9]+)([a-zA-Z]*)$/.exec(s);
  if (m === null) return null;
  const mul = UNITS[m[2]!.toLowerCase()];
  if (mul === undefined) return null;
  const n = BigInt(m[1]!) * mul;
  return n > ULLONG_MAX ? null : n;
}

/** A memory size such as `64mb` in bytes, or null. */
export function parseMemory(s: string): number | null {
  const n = parseMemoryBig(s);
  return n === null ? null : Number(n);
}

const checkRange = (n: bigint, min: bigint, max: bigint): number => {
  if (n < min || n > max)
    throw new InvalidValue(`argument must be between ${min} and ${max} inclusive`);
  return Number(n);
};

function int(
  def: number,
  min: bigint,
  max: bigint,
  mutable: boolean,
  clamp?: readonly [number, number],
): DirectiveSpec<number> {
  return {
    default: String(def),
    mutable,
    parse(raw) {
      const n = parseInt64(raw);
      if (n === null) throw new InvalidValue("argument couldn't be parsed into an integer");
      const v = checkRange(n, min, max);
      return clamp ? Math.min(Math.max(v, clamp[0]), clamp[1]) : v;
    },
    format: String,
  };
}

function memory(def: string, min: bigint, max: bigint, mutable: boolean): DirectiveSpec<number> {
  return {
    default: def,
    mutable,
    parse(raw) {
      const n = parseMemoryBig(raw);
      if (n === null) throw new InvalidValue('argument must be a memory value');
      return checkRange(n, min, max);
    },
    format: String,
  };
}

function bool(def: 'yes' | 'no', mutable: boolean): DirectiveSpec<boolean> {
  return {
    default: def,
    mutable,
    parse(raw) {
      const s = raw.toLowerCase();
      if (s === 'yes') return true;
      if (s === 'no') return false;
      throw new InvalidValue("argument must be 'yes' or 'no'");
    },
    format: (v) => (v ? 'yes' : 'no'),
  };
}

function oneOf<T extends string>(
  def: T,
  options: readonly T[],
  mutable: boolean,
): DirectiveSpec<T> {
  return {
    default: def,
    mutable,
    parse(raw) {
      const s = raw.toLowerCase();
      const found = options.find((o) => o === s);
      if (found === undefined)
        throw new InvalidValue(`argument(s) must be one of the following: ${options.join(', ')}`);
      return found;
    },
    format: (v) => v,
  };
}

function str(def: string, mutable: boolean): DirectiveSpec<string> {
  return { default: def, mutable, parse: (raw) => raw, format: (v) => v };
}

const words = (raw: string): string[] => (raw === '' ? [] : raw.split(' '));

const save: DirectiveSpec<SavePoint[]> = {
  default: '3600 1 300 100 60 10000',
  mutable: true,
  multiWord: true,
  parse(raw) {
    const w = words(raw);
    const invalid = new InvalidValue('Invalid save parameters');
    if (w.length % 2 !== 0) throw invalid;
    const points: SavePoint[] = [];
    for (let i = 0; i < w.length; i += 2) {
      const seconds = parseInt64(w[i]!);
      const changes = parseInt64(w[i + 1]!);
      if (seconds === null || changes === null || seconds < 1n || changes < 0n) throw invalid;
      points.push({ seconds: Number(seconds), changes: Number(changes) });
    }
    return points;
  },
  format: (points) => points.map((p) => `${p.seconds} ${p.changes}`).join(' '),
};

const OUTPUT_CLASSES: Record<string, keyof OutputLimits> = {
  normal: 'normal',
  replica: 'replica',
  slave: 'replica',
  pubsub: 'pubsub',
};

const outputLimits: DirectiveSpec<OutputLimits> = {
  default: 'normal 0 0 0 replica 256mb 64mb 60 pubsub 32mb 8mb 60',
  mutable: true,
  multiWord: true,
  parse(raw, current) {
    const w = words(raw);
    if (w.length % 4 !== 0)
      throw new InvalidValue('Wrong number of arguments in buffer limit configuration.');
    const none: OutputLimit = { hard: 0, soft: 0, softSeconds: 0 };
    const next: OutputLimits = {
      normal: { ...(current?.normal ?? none) },
      replica: { ...(current?.replica ?? none) },
      pubsub: { ...(current?.pubsub ?? none) },
    };
    for (let i = 0; i < w.length; i += 4) {
      const cls = OUTPUT_CLASSES[w[i]!.toLowerCase()];
      if (cls === undefined)
        throw new InvalidValue('Invalid client class specified in buffer limit configuration.');
      const hard = parseMemory(w[i + 1]!);
      const soft = parseMemory(w[i + 2]!);
      const seconds = parseInt64(w[i + 3]!);
      if (hard === null || soft === null || seconds === null || seconds < 0n)
        throw new InvalidValue(
          'Error in hard, soft or soft_seconds setting in buffer limit configuration.',
        );
      next[cls] = { hard, soft, softSeconds: Number(seconds) };
    }
    return next;
  },
  // Redis prints the replica class by its old name, and sizes in bytes.
  format: (l) =>
    [
      ['normal', l.normal],
      ['slave', l.replica],
      ['pubsub', l.pubsub],
    ]
      .map(([name, x]) => {
        const lim = x as OutputLimit;
        return `${name as string} ${lim.hard} ${lim.soft} ${lim.softSeconds}`;
      })
      .join(' '),
};

const replicaof: DirectiveSpec<ReplicaOf | null> = {
  default: '',
  mutable: false, // changed at runtime through REPLICAOF, which also starts the handshake
  multiWord: true,
  parse(raw) {
    if (raw === '' || raw.toLowerCase() === 'no one') return null;
    const w = words(raw);
    if (w.length !== 2) throw new InvalidValue('Bad directive or wrong number of arguments');
    const port = parseInt64(w[1]!);
    if (port === null || port < 0n || port > 65535n) throw new InvalidValue('Invalid master port');
    return { host: w[0]!, port: Number(port) };
  },
  format: (v) => (v === null ? '' : `${v.host} ${v.port}`),
};

/** Section 5's table, in its order; CONFIG GET with a pattern answers in this order too. */
const DIRECTIVES: { [K in ConfigName]: DirectiveSpec<ConfigValues[K]> } = {
  port: int(6380, 0n, 65535n, false),
  bind: str('127.0.0.1', false),
  requirepass: str('', true),
  databases: int(16, 1n, INT_MAX, false),
  maxclients: int(10000, 1n, UINT_MAX, true),
  timeout: int(0, 0n, INT_MAX, true),
  'tcp-keepalive': int(300, 0n, INT_MAX, false),
  hz: int(10, 0n, INT_MAX, true, [1, 500]), // CONFIG_MIN_HZ and CONFIG_MAX_HZ
  loglevel: oneOf<LogLevel>('notice', LOG_LEVELS, true),
  dir: str('./data', false),
  dbfilename: str('dump.mrdb', false),
  save,
  appendonly: bool('no', true),
  appendfilename: str('appendonly.aof', false),
  appendfsync: oneOf<FsyncPolicy>('everysec', FSYNC_POLICIES, true),
  'aof-load-truncated': bool('yes', true),
  'auto-aof-rewrite-percentage': int(100, 0n, INT_MAX, true),
  'auto-aof-rewrite-min-size': memory('64mb', 0n, LLONG_MAX, true),
  maxmemory: memory('0', 0n, ULLONG_MAX, true),
  'maxmemory-policy': oneOf<EvictionPolicy>('noeviction', EVICTION_POLICIES, true),
  'maxmemory-samples': int(5, 1n, 64n, true),
  'lfu-log-factor': int(10, 0n, INT_MAX, true),
  'lfu-decay-time': int(1, 0n, INT_MAX, true),
  'list-max-node-items': int(128, 1n, INT_MAX, true),
  // Redis allows up to LLONG_MAX; a bulk becomes one JS string, so V8's limit is ours.
  'proto-max-bulk-len': memory('64mb', MB, BigInt(bufferConstants.MAX_STRING_LENGTH), true),
  'client-query-buffer-limit': memory('256mb', MB, LLONG_MAX, true),
  'client-output-buffer-limit': outputLimits,
  'slowlog-log-slower-than': int(10000, -1n, LLONG_MAX, true),
  'slowlog-max-len': int(128, 0n, LLONG_MAX, true),
  replicaof,
  masterauth: str('', true),
  'replica-read-only': bool('yes', true),
  'repl-backlog-size': memory('1mb', 1n, LLONG_MAX, true),
  'repl-timeout': int(60, 1n, INT_MAX, true),
  'repl-ping-replica-period': int(10, 1n, INT_MAX, true),
  'enable-debug-command': bool('no', false),
  'metrics-port': int(0, 0n, 65535n, false),
};

const NAMES = Object.keys(DIRECTIVES) as ConfigName[];

const lookup = (name: string): ConfigName | undefined => {
  const lower = name.toLowerCase();
  return Object.hasOwn(DIRECTIVES, lower) ? (lower as ConfigName) : undefined;
};

// The table's mapped type can't be indexed by a generic key without help; these keep the casts
// in one place.
type AnySpec = DirectiveSpec<unknown>;
const specOf = (name: ConfigName): AnySpec => DIRECTIVES[name] as AnySpec;

const BAD_DIRECTIVE = 'Bad directive or wrong number of arguments';

/** The lines of a config file that hold directives, split with Redis's quoting rules. */
export function parseConfigFile(text: string): DirectiveLine[] {
  const out: DirectiveLine[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const where = `at line ${i + 1}`;
    let args: string[];
    try {
      args = splitArgs(Buffer.from(line, 'latin1'));
    } catch (e) {
      if (e instanceof ProtocolError)
        throw new ConfigError(where, line, 'Unbalanced quotes in configuration line');
      throw e;
    }
    if (args.length > 0) out.push({ args, where, line });
  }
  return out;
}

/** `node index.js [configfile] [--name value ...]...`, like redis-server. */
export function parseArgv(argv: readonly string[]): {
  configFile: string | null;
  directives: DirectiveLine[];
} {
  let i = 0;
  let configFile: string | null = null;
  if (argv.length > 0 && !argv[0]!.startsWith('--')) configFile = argv[i++]!;
  const directives: DirectiveLine[] = [];
  const where = 'from the command line';
  while (i < argv.length) {
    const flag = argv[i++]!;
    if (!flag.startsWith('--') || flag.length === 2)
      throw new ConfigError(where, flag, 'Invalid argument; directives start with --');
    const values: string[] = [];
    while (i < argv.length && !argv[i]!.startsWith('--')) values.push(argv[i++]!);
    // A bare `--save` means `save ""`, as in redis-server.
    if (values.length === 0) values.push('');
    const args = [flag.slice(2), ...values];
    directives.push({ args, where, line: `--${args.join(' ')}` });
  }
  return { configFile, directives };
}

export class Config {
  /** Path of the config file it was loaded from, for INFO's config_file; '' if none. */
  file = '';
  private readonly values: ConfigValues;
  private readonly listeners: Array<(names: readonly ConfigName[]) => void> = [];

  constructor() {
    const values: Partial<Record<ConfigName, unknown>> = {};
    for (const name of NAMES) {
      const spec = specOf(name);
      values[name] = spec.parse(spec.default, undefined);
    }
    this.values = values as ConfigValues;
  }

  /** Defaults, then each directive in order, so later lines (and flags) win. */
  static fromDirectives(lines: readonly DirectiveLine[]): Config {
    const config = new Config();
    for (const { args, where, line } of lines) {
      const name = lookup(args[0]!);
      if (name === undefined) throw new ConfigError(where, line, BAD_DIRECTIVE);
      const spec = specOf(name);
      const values = args.slice(1);
      if (!spec.multiWord && values.length !== 1) throw new ConfigError(where, line, BAD_DIRECTIVE);
      try {
        (config.values as unknown as Record<string, unknown>)[name] = spec.parse(
          values.join(' '),
          config.values[name],
        );
      } catch (e) {
        if (e instanceof InvalidValue) throw new ConfigError(where, line, e.message);
        throw e;
      }
    }
    return config;
  }

  get<K extends ConfigName>(name: K): ConfigValues[K] {
    return this.values[name];
  }

  /** Runs after every successful CONFIG SET with the directives it changed. */
  onChange(listener: (names: readonly ConfigName[]) => void): void {
    this.listeners.push(listener);
  }

  /**
   * CONFIG GET's pairs. A plain name is looked up directly and echoed as typed; a pattern is
   * matched case-insensitively against every name. Each directive appears once.
   */
  getMatching(patterns: readonly string[]): Array<[string, string]> {
    const seen = new Set<ConfigName>();
    const out: Array<[string, string]> = [];
    const add = (name: ConfigName, shownAs: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      out.push([shownAs, specOf(name).format(this.values[name])]);
    };
    for (const pattern of patterns) {
      if (!hasGlobChars(pattern)) {
        const name = lookup(pattern);
        if (name !== undefined) add(name, pattern);
        continue;
      }
      for (const name of NAMES) if (stringMatch(pattern, name, true)) add(name, name);
    }
    return out;
  }

  /** CONFIG SET name value [name value ...]: all pairs are checked before any is applied. */
  setMany(args: readonly string[]): void {
    if (args.length % 2 !== 0) throw new ReplyError(ERR.SYNTAX);
    const failed = (arg: string, reason: string): ReplyError =>
      new ReplyError(`ERR CONFIG SET failed (possibly related to argument '${arg}') - ${reason}`);

    const names: ConfigName[] = [];
    for (let i = 0; i < args.length; i += 2) {
      const arg = args[i]!;
      const name = lookup(arg);
      if (name === undefined)
        throw new ReplyError(`ERR Unknown option or number of arguments for CONFIG SET - '${arg}'`);
      if (!specOf(name).mutable) throw failed(arg, "can't set immutable config");
      if (names.includes(name)) throw failed(arg, 'duplicate parameter');
      names.push(name);
    }

    const parsed: unknown[] = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      try {
        parsed.push(specOf(name).parse(args[i * 2 + 1]!, this.values[name]));
      } catch (e) {
        if (e instanceof InvalidValue) throw failed(args[i * 2]!, e.message);
        throw e;
      }
    }

    const values = this.values as unknown as Record<string, unknown>;
    names.forEach((name, i) => (values[name] = parsed[i]));
    for (const listener of this.listeners) listener(names);
  }
}
