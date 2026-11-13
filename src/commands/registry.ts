/**
 * The command table (spec 7.9): every command MiniRedis knows, collected from the
 * commands/*.ts modules.
 *
 * Key design choice: each Server builds its own Map from the shared immutable specs, so a test
 * can add a command to one server without touching another (spec 4: no module-level mutable
 * state).
 *
 * Mirrors Redis server.c (populateCommandTable, lookupCommand).
 */
import type { CommandTable } from './command.js';
import { connectionCommands } from './connection.js';
import { debugCommands } from './debug.js';
import { keyCommands } from './keys.js';
import { serverCommands } from './server.js';
import { stringCommands } from './strings.js';

export function buildCommandTable(): CommandTable {
  const table: CommandTable = new Map();
  for (const spec of [
    ...connectionCommands,
    ...stringCommands,
    ...keyCommands,
    ...serverCommands,
    ...debugCommands,
  ]) {
    if (table.has(spec.name)) throw new Error(`duplicate command '${spec.name}'`);
    table.set(spec.name, spec);
  }
  return table;
}
