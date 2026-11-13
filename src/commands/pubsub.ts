/**
 * Pub/sub commands (spec 8.7): SUBSCRIBE, PSUBSCRIBE, UNSUBSCRIBE, PUNSUBSCRIBE, PUBLISH and
 * PUBSUB CHANNELS | NUMSUB | NUMPAT.
 *
 * Key design choice: the handlers only talk to the hub and the caller's reply; the hub does the
 * fan-out. Every confirmation is a push frame, which is a plain array in RESP2 and a `>` frame
 * in RESP3, so one code path serves both. PUBLISH changes no data, so the dispatcher wouldn't
 * propagate it; it asks for a record itself, marked replicas-only (spec 9.5), even when nobody
 * received the message, because a replica's own subscribers may be listening.
 *
 * Mirrors Redis pubsub.c (subscribeCommand, psubscribeCommand, unsubscribeCommand,
 * punsubscribeCommand, publishCommand, pubsubCommand).
 */
import { ReplyError } from '../protocol/errors.js';
import { command, containerOnly } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';

export function subscribeCommand(ctx: CommandContext): void {
  const { client, server } = ctx;
  for (const channel of ctx.argv.slice(1)) {
    server.pubsub.subscribe(client, channel);
    ctx.reply.push(['subscribe', channel, server.pubsub.count(client)]);
  }
}

export function psubscribeCommand(ctx: CommandContext): void {
  const { client, server } = ctx;
  for (const pattern of ctx.argv.slice(1)) {
    server.pubsub.psubscribe(client, pattern);
    ctx.reply.push(['psubscribe', pattern, server.pubsub.count(client)]);
  }
}

export function unsubscribeCommand(ctx: CommandContext): void {
  const { client, server } = ctx;
  // No arguments means every channel, and a client with none still gets one reply (nil, 0).
  const channels = ctx.argv.length > 1 ? ctx.argv.slice(1) : [...client.channels];
  if (channels.length === 0) {
    ctx.reply.push(['unsubscribe', null, server.pubsub.count(client)]);
    return;
  }
  for (const channel of channels) {
    server.pubsub.unsubscribe(client, channel);
    ctx.reply.push(['unsubscribe', channel, server.pubsub.count(client)]);
  }
}

export function punsubscribeCommand(ctx: CommandContext): void {
  const { client, server } = ctx;
  const patterns = ctx.argv.length > 1 ? ctx.argv.slice(1) : [...client.patterns];
  if (patterns.length === 0) {
    ctx.reply.push(['punsubscribe', null, server.pubsub.count(client)]);
    return;
  }
  for (const pattern of patterns) {
    server.pubsub.punsubscribe(client, pattern);
    ctx.reply.push(['punsubscribe', pattern, server.pubsub.count(client)]);
  }
}

export function publishCommand(ctx: CommandContext): void {
  const receivers = ctx.server.pubsub.publish(ctx.argv[1]!, ctx.argv[2]!);
  ctx.alsoPropagate(ctx.argv, true);
  ctx.reply.integer(receivers);
}

export function pubsubChannelsCommand(ctx: CommandContext): void {
  // Arity -2 lets a stray extra argument through; Redis's handler rejects it with this legacy
  // text, naming the subcommand as the client typed it.
  if (ctx.argv.length > 3)
    throw new ReplyError(
      `ERR unknown subcommand or wrong number of arguments for '${ctx.argv[1]}'. Try PUBSUB HELP.`,
    );
  ctx.reply.array(ctx.server.pubsub.channels(ctx.argv[2]));
}

export function pubsubNumsubCommand(ctx: CommandContext): void {
  // A flat channel, count, channel, count… list in RESP3 too, as Redis replies.
  const out: (string | number)[] = [];
  for (const channel of ctx.argv.slice(2)) out.push(channel, ctx.server.pubsub.numSub(channel));
  ctx.reply.array(out);
}

export function pubsubNumpatCommand(ctx: CommandContext): void {
  ctx.reply.integer(ctx.server.pubsub.numPat());
}

export const pubsubCommands: CommandSpec[] = [
  command('subscribe', -2, ['pubsub'], [0, 0, 0], subscribeCommand),
  command('psubscribe', -2, ['pubsub'], [0, 0, 0], psubscribeCommand),
  command('unsubscribe', -1, ['pubsub'], [0, 0, 0], unsubscribeCommand),
  command('punsubscribe', -1, ['pubsub'], [0, 0, 0], punsubscribeCommand),
  command('publish', 3, ['pubsub'], [0, 0, 0], publishCommand),
  command('pubsub', -2, ['pubsub'], [0, 0, 0], containerOnly, [
    command('pubsub|channels', -2, ['pubsub'], [0, 0, 0], pubsubChannelsCommand),
    command('pubsub|numsub', -2, ['pubsub'], [0, 0, 0], pubsubNumsubCommand),
    command('pubsub|numpat', 2, ['pubsub'], [0, 0, 0], pubsubNumpatCommand),
  ]),
];
