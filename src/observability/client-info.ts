/**
 * One client as a CLIENT LIST / CLIENT INFO line (spec 13.4).
 *
 * Key design choice: a pure function from a Client to its line, in the field order of the spec,
 * so CLIENT LIST, CLIENT INFO and any log line that wants a client's state print it the same way.
 * Flags follow Redis's letters: `N` when nothing else applies, `O` for a MONITOR client, `S` a
 * replica, `M` the link to our primary, `P` a subscriber, `x` inside MULTI, `b` blocked, `d`
 * a watched key changed, `c` closing after its reply.
 *
 * Mirrors Redis networking.c (catClientInfoString).
 */
import type { Client } from '../server/client.js';
import { outputBytes } from '../server/limits.js';

export function clientFlags(client: Client): string {
  let f = '';
  if (client.monitor) f += 'O';
  else if (client.repl !== null) f += 'S';
  if (client.primaryLink) f += 'M';
  if (client.channels.size + client.patterns.size > 0) f += 'P';
  if (client.multi) f += 'x';
  if (client.blocked) f += 'b';
  if (client.dirtyCas) f += 'd';
  if (client.closeAfterReply) f += 'c';
  return f === '' ? 'N' : f;
}

export function clientInfoLine(client: Client, now: number = Date.now()): string {
  return (
    `id=${client.id} addr=${client.addr} laddr=${client.laddr} name=${client.name} ` +
    `age=${Math.floor((now - client.createdAt) / 1000)} ` +
    `idle=${Math.floor((now - client.lastInteraction) / 1000)} ` +
    `flags=${clientFlags(client)} db=${client.db} ` +
    `sub=${client.channels.size} psub=${client.patterns.size} ` +
    `multi=${client.multi ? client.queued.length : -1} ` +
    `qbuf=${client.parser.bufferedBytes} omem=${outputBytes(client)} ` +
    `cmd=${client.lastCommand === '' ? 'NULL' : client.lastCommand} resp=${client.resp}`
  );
}
