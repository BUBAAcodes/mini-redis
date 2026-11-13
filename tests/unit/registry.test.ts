import { describe, expect, it } from 'vitest';
import { arityOk, lookupSubcommand } from '../../src/commands/command.js';
import type { CommandSpec } from '../../src/commands/command.js';
import { buildCommandTable } from '../../src/commands/registry.js';

const allSpecs = (): CommandSpec[] =>
  [...buildCommandTable().values()].flatMap((s) => [s, ...Object.values(s.subcommands ?? {})]);

/** 'client|setname' → 'clientSetnameCommand' (section 0: handlers are named after commands). */
const handlerName = (name: string): string =>
  name
    .split('|')
    .map((part, i) => (i === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join('') + 'Command';

describe('command table (spec 7.9)', () => {
  it('has every command built so far (steps 5 and 6)', () => {
    const names = [...buildCommandTable().keys()].sort();
    expect(names).toEqual(
      [
        'append',
        'client',
        'command',
        'config',
        'dbsize',
        'decr',
        'decrby',
        'del',
        'echo',
        'exists',
        'flushall',
        'flushdb',
        'get',
        'getdel',
        'getrange',
        'incr',
        'incrby',
        'incrbyfloat',
        'info',
        'keys',
        'mget',
        'mset',
        'ping',
        'quit',
        'randomkey',
        'rename',
        'scan',
        'select',
        'set',
        'setrange',
        'strlen',
        'time',
        'type',
        'unlink',
      ].sort(),
    );
  });

  it('builds a fresh table per call', () => {
    expect(buildCommandTable()).not.toBe(buildCommandTable());
  });

  it('names are lowercase; subcommands are parent|sub', () => {
    for (const spec of buildCommandTable().values()) {
      expect(spec.name).toBe(spec.name.toLowerCase());
      for (const [key, sub] of Object.entries(spec.subcommands ?? {})) {
        expect(sub.name).toBe(`${spec.name}|${key}`);
      }
    }
  });

  it('every handler is named after its command, except containers', () => {
    for (const spec of allSpecs()) {
      if (spec.handler.name === 'containerOnly') {
        expect(spec.subcommands).toBeDefined();
        continue;
      }
      expect(spec.handler.name, spec.name).toBe(handlerName(spec.name));
    }
  });

  it('arities are never 0, and key positions are consistent', () => {
    for (const spec of allSpecs()) {
      expect(spec.arity, spec.name).not.toBe(0);
      if (spec.firstKey === 0) expect([spec.lastKey, spec.step], spec.name).toEqual([0, 0]);
      else expect(spec.step, spec.name).toBeGreaterThan(0);
    }
  });

  it('write and readonly never go together', () => {
    for (const spec of allSpecs()) {
      expect(spec.flags.includes('write') && spec.flags.includes('readonly'), spec.name).toBe(
        false,
      );
    }
  });
});

describe('arity and subcommand lookup', () => {
  it('positive arity is exact; negative is a minimum', () => {
    expect(arityOk(2, 2)).toBe(true);
    expect(arityOk(2, 3)).toBe(false);
    expect(arityOk(-2, 2)).toBe(true);
    expect(arityOk(-2, 5)).toBe(true);
    expect(arityOk(-2, 1)).toBe(false);
  });

  it('finds subcommands case-insensitively, and nothing from Object.prototype', () => {
    const config = buildCommandTable().get('config')!;
    expect(lookupSubcommand(config, 'GET')?.name).toBe('config|get');
    expect(lookupSubcommand(config, 'toString')).toBeUndefined();
    expect(lookupSubcommand(config, '__proto__')).toBeUndefined();
  });
});
