import { describe, expect, it } from 'vitest';
import { Config, ConfigError, parseArgv, parseConfigFile, parseMemory } from '../../src/config.js';
import { ReplyError } from '../../src/protocol/errors.js';

const setError = (c: Config, ...args: string[]): string => {
  try {
    c.setMany(args);
  } catch (e) {
    expect(e).toBeInstanceOf(ReplyError);
    return (e as Error).message;
  }
  throw new Error('expected CONFIG SET to fail');
};

describe('memory units (spec 5)', () => {
  it("follows Redis's units", () => {
    expect(parseMemory('0')).toBe(0);
    expect(parseMemory('100')).toBe(100);
    expect(parseMemory('100b')).toBe(100);
    expect(parseMemory('1k')).toBe(1000);
    expect(parseMemory('1kb')).toBe(1024);
    expect(parseMemory('1K')).toBe(1000);
    expect(parseMemory('1KB')).toBe(1024);
    expect(parseMemory('1m')).toBe(1_000_000);
    expect(parseMemory('1mb')).toBe(1_048_576);
    expect(parseMemory('2g')).toBe(2_000_000_000);
    expect(parseMemory('1gb')).toBe(1_073_741_824);
  });

  it('rejects anything else', () => {
    for (const bad of ['', '-1', '1x', '1 mb', 'mb', '1.5mb', 'abc']) {
      expect(parseMemory(bad), bad).toBeNull();
    }
  });
});

describe('defaults (spec 5)', () => {
  it('starts with the table in section 5', () => {
    const c = new Config();
    expect(c.get('port')).toBe(6380);
    expect(c.get('bind')).toBe('127.0.0.1');
    expect(c.get('databases')).toBe(16);
    expect(c.get('hz')).toBe(10);
    expect(c.get('dir')).toBe('./data');
    expect(c.get('save')).toEqual([
      { seconds: 3600, changes: 1 },
      { seconds: 300, changes: 100 },
      { seconds: 60, changes: 10000 },
    ]);
    expect(c.get('appendonly')).toBe(false);
    expect(c.get('appendfsync')).toBe('everysec');
    expect(c.get('auto-aof-rewrite-min-size')).toBe(64 * 1024 * 1024);
    expect(c.get('maxmemory-policy')).toBe('noeviction');
    expect(c.get('proto-max-bulk-len')).toBe(64 * 1024 * 1024);
    expect(c.get('client-query-buffer-limit')).toBe(256 * 1024 * 1024);
    expect(c.get('client-output-buffer-limit')).toEqual({
      normal: { hard: 0, soft: 0, softSeconds: 0 },
      replica: { hard: 256 * 1024 * 1024, soft: 64 * 1024 * 1024, softSeconds: 60 },
      pubsub: { hard: 32 * 1024 * 1024, soft: 8 * 1024 * 1024, softSeconds: 60 },
    });
    expect(c.get('replicaof')).toBeNull();
    expect(c.get('enable-debug-command')).toBe(false);
    expect(c.get('metrics-port')).toBe(0);
  });
});

describe('config file and flags', () => {
  it('reads directives, comments, blank lines and quotes', () => {
    const lines = parseConfigFile(
      '# a comment\n\nport 7000\n  requirepass "a b\\x41"\nSAVE 60 1\n',
    );
    expect(lines.map((l) => [l.where, l.args])).toEqual([
      ['at line 3', ['port', '7000']],
      ['at line 4', ['requirepass', 'a bA']],
      ['at line 5', ['SAVE', '60', '1']],
    ]);
    expect(lines[1]!.line).toBe('requirepass "a b\\x41"');
  });

  it('reports unbalanced quotes with the line number', () => {
    expect(() => parseConfigFile('port 1\nrequirepass "oops\n')).toThrow(ConfigError);
    try {
      parseConfigFile('port 1\nrequirepass "oops\n');
    } catch (e) {
      expect((e as ConfigError).where).toBe('at line 2');
    }
  });

  it('splits argv into a config file and --flags', () => {
    expect(
      parseArgv(['my.conf', '--port', '6381', '--save', '', '--replicaof', 'h', '6382']),
    ).toEqual({
      configFile: 'my.conf',
      directives: [
        { args: ['port', '6381'], where: 'from the command line', line: '--port 6381' },
        { args: ['save', ''], where: 'from the command line', line: '--save ' },
        {
          args: ['replicaof', 'h', '6382'],
          where: 'from the command line',
          line: '--replicaof h 6382',
        },
      ],
    });
    expect(parseArgv([]).configFile).toBeNull();
    expect(parseArgv(['--save']).directives[0]!.args).toEqual(['save', '']);
  });

  it('applies the file, then flags on top', () => {
    const file = parseConfigFile('port 7000\nhz 20\n');
    const flags = parseArgv(['--port', '7001', '--save', '']).directives;
    const c = Config.fromDirectives([...file, ...flags]);
    expect(c.get('port')).toBe(7001);
    expect(c.get('hz')).toBe(20);
    expect(c.get('save')).toEqual([]);
  });

  it('takes multi-word values for save, client-output-buffer-limit and replicaof', () => {
    const c = Config.fromDirectives(
      parseConfigFile(
        'save 900 1 300 10\nclient-output-buffer-limit pubsub 1mb 1kb 5\nreplicaof 10.0.0.1 6390\n',
      ),
    );
    expect(c.get('save')).toEqual([
      { seconds: 900, changes: 1 },
      { seconds: 300, changes: 10 },
    ]);
    expect(c.get('client-output-buffer-limit').pubsub).toEqual({
      hard: 1_048_576,
      soft: 1024,
      softSeconds: 5,
    });
    expect(c.get('client-output-buffer-limit').normal.hard).toBe(0); // other classes untouched
    expect(c.get('replicaof')).toEqual({ host: '10.0.0.1', port: 6390 });
  });

  it('fails with the line and the reason, like Redis', () => {
    const fail = (text: string): ConfigError => {
      try {
        Config.fromDirectives(parseConfigFile(text));
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return e as ConfigError;
      }
      throw new Error('expected a ConfigError');
    };
    expect(fail('port abc')).toMatchObject({
      where: 'at line 1',
      line: 'port abc',
      reason: "argument couldn't be parsed into an integer",
    });
    expect(fail('\nnosuch 1').reason).toBe('Bad directive or wrong number of arguments');
    expect(fail('port 1 2').reason).toBe('Bad directive or wrong number of arguments');
    expect(fail('maxmemory lots').reason).toBe('argument must be a memory value');
    expect(fail('appendonly maybe').reason).toBe("argument must be 'yes' or 'no'");
  });
});

describe('CONFIG GET', () => {
  it('matches globs case-insensitively and returns canonical names', () => {
    const c = new Config();
    expect(c.getMatching(['maxmemory*'])).toEqual([
      ['maxmemory', '0'],
      ['maxmemory-policy', 'noeviction'],
      ['maxmemory-samples', '5'],
    ]);
    expect(c.getMatching(['P?RT'])).toEqual([['port', '6380']]);
  });

  it('echoes a plain name the way it was typed, as Redis does', () => {
    const c = new Config();
    expect(c.getMatching(['PORT', 'nosuch'])).toEqual([['PORT', '6380']]);
  });

  it('returns each directive once, even if several patterns match it', () => {
    const c = new Config();
    expect(c.getMatching(['hz', 'h*'])).toEqual([['hz', '10']]);
  });

  it('formats values the way Redis prints them', () => {
    const c = new Config();
    expect(c.getMatching(['save'])).toEqual([['save', '3600 1 300 100 60 10000']]);
    expect(c.getMatching(['client-output-buffer-limit'])).toEqual([
      [
        'client-output-buffer-limit',
        'normal 0 0 0 slave 268435456 67108864 60 pubsub 33554432 8388608 60',
      ],
    ]);
    expect(c.getMatching(['appendonly', 'replicaof', 'requirepass'])).toEqual([
      ['appendonly', 'no'],
      ['replicaof', ''],
      ['requirepass', ''],
    ]);
  });
});

describe('CONFIG SET', () => {
  it('sets mutable directives, with units', () => {
    const c = new Config();
    c.setMany(['maxmemory', '1kb', 'MAXMEMORY-POLICY', 'allkeys-lru', 'appendonly', 'YES']);
    expect(c.get('maxmemory')).toBe(1024);
    expect(c.get('maxmemory-policy')).toBe('allkeys-lru');
    expect(c.get('appendonly')).toBe(true);
    c.setMany(['save', '']);
    expect(c.get('save')).toEqual([]);
  });

  it('clamps hz to 1..500, as Redis does', () => {
    const c = new Config();
    c.setMany(['hz', '0']);
    expect(c.get('hz')).toBe(1);
    c.setMany(['hz', '600']);
    expect(c.get('hz')).toBe(500);
  });

  it('gives the Redis 7.4 error for each kind of mistake', () => {
    const c = new Config();
    expect(setError(c, 'nosuch', '1')).toBe(
      "ERR Unknown option or number of arguments for CONFIG SET - 'nosuch'",
    );
    expect(setError(c, 'databases', '3')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'databases') - can't set immutable config",
    );
    expect(setError(c, 'hz', '10', 'hz', '11')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'hz') - duplicate parameter",
    );
    expect(setError(c, 'hz', '10', 'maxclients')).toBe('ERR syntax error');
    expect(setError(c, 'hz', 'abc')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'hz') - argument couldn't be parsed into an integer",
    );
    expect(setError(c, 'hz', '-1')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'hz') - argument must be between 0 and 2147483647 inclusive",
    );
    expect(setError(c, 'maxclients', '0')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'maxclients') - argument must be between 1 and 4294967295 inclusive",
    );
    expect(setError(c, 'maxmemory', 'abc')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'maxmemory') - argument must be a memory value",
    );
    expect(setError(c, 'appendonly', 'maybe')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'appendonly') - argument must be 'yes' or 'no'",
    );
    expect(setError(c, 'appendfsync', 'bogus')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'appendfsync') - argument(s) must be one of the following: everysec, always, no",
    );
    expect(setError(c, 'maxmemory-policy', 'foo')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'maxmemory-policy') - argument(s) must be one of the following: volatile-lru, volatile-lfu, volatile-random, volatile-ttl, allkeys-lru, allkeys-lfu, allkeys-random, noeviction",
    );
    expect(setError(c, 'save', '3600 1 300')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'save') - Invalid save parameters",
    );
    expect(setError(c, 'client-output-buffer-limit', 'bogus')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'client-output-buffer-limit') - Wrong number of arguments in buffer limit configuration.",
    );
    expect(setError(c, 'slowlog-log-slower-than', '-5')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'slowlog-log-slower-than') - argument must be between -1 and 9223372036854775807 inclusive",
    );
    expect(setError(c, 'maxmemory-samples', '0')).toBe(
      "ERR CONFIG SET failed (possibly related to argument 'maxmemory-samples') - argument must be between 1 and 64 inclusive",
    );
  });

  it('changes nothing when any pair is bad (rule 4)', () => {
    const c = new Config();
    setError(c, 'hz', '20', 'maxmemory', 'abc');
    expect(c.get('hz')).toBe(10);
    expect(c.get('maxmemory')).toBe(0);
  });

  it('tells listeners which directives changed', () => {
    const c = new Config();
    const seen: string[][] = [];
    c.onChange((names) => seen.push([...names]));
    c.setMany(['hz', '20', 'timeout', '5']);
    expect(seen).toEqual([['hz', 'timeout']]);
  });
});
