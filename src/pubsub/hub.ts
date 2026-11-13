/**
 * The pub/sub hub (spec 9.11): which clients listen on which channels and glob patterns, and
 * the fan-out of one published message to all of them.
 *
 * Key design choice: the registry is indexed both ways, as the WATCH registry is. The hub maps
 * channel → subscribers and pattern → subscribers, and each client keeps its own `channels` and
 * `patterns` sets, so PUBLISH finds its targets without scanning clients and a disconnect or a
 * bare UNSUBSCRIBE finds a client's subscriptions without scanning the hub. The hub never
 * touches sockets: it hands each frame to a `deliver` callback, which appends it to the client's
 * output queue, so delivery obeys the same ordering and batching rules as any reply (rule 12).
 * Maps are fine here (spec 0): the registry is small and isn't the keyspace.
 *
 * Mirrors Redis pubsub.c (pubsubSubscribeChannel, pubsubSubscribePattern, pubsubPublishMessage,
 * pubsubUnsubscribeAllChannels).
 */
import type { ReplyItem } from '../protocol/encoder.js';
import { stringMatch } from '../utils/glob.js';

/** What the hub needs of a client: the two sets that mirror its entries here. */
export interface Subscriber {
  readonly channels: Set<string>;
  readonly patterns: Set<string>;
}

/** RESP2 can't tell a reply from a pushed message, so a subscriber's commands are limited. */
export function inSubscriberMode(client: Subscriber & { readonly resp: 2 | 3 }): boolean {
  return client.resp === 2 && client.channels.size + client.patterns.size > 0;
}

export class PubSubHub<S extends Subscriber> {
  private readonly byChannel = new Map<string, Set<S>>();
  private readonly byPattern = new Map<string, Set<S>>();

  /** Called once per message frame to queue it for one client (and schedule its write). */
  constructor(private readonly deliver: (sub: S, frame: readonly ReplyItem[]) => void) {}

  /** The count reported in confirmations: channels and patterns together. */
  count(sub: S): number {
    return sub.channels.size + sub.patterns.size;
  }

  /** True if this is a new subscription; a repeat changes nothing. */
  subscribe(sub: S, channel: string): boolean {
    return this.add(this.byChannel, sub.channels, sub, channel);
  }

  unsubscribe(sub: S, channel: string): boolean {
    return this.remove(this.byChannel, sub.channels, sub, channel);
  }

  psubscribe(sub: S, pattern: string): boolean {
    return this.add(this.byPattern, sub.patterns, sub, pattern);
  }

  punsubscribe(sub: S, pattern: string): boolean {
    return this.remove(this.byPattern, sub.patterns, sub, pattern);
  }

  /** A client going away: no confirmations, just leave every channel and pattern. */
  unsubscribeAll(sub: S): void {
    for (const channel of [...sub.channels]) this.unsubscribe(sub, channel);
    for (const pattern of [...sub.patterns]) this.punsubscribe(sub, pattern);
  }

  /**
   * Sends `message` to the channel's subscribers, then to the subscribers of every matching
   * pattern, as Redis does. Returns the number of frames sent: a client listening through a
   * channel and a pattern, or two patterns, counts once for each.
   */
  publish(channel: string, message: string): number {
    let receivers = 0;
    const direct = this.byChannel.get(channel);
    if (direct !== undefined) {
      for (const sub of direct) {
        this.deliver(sub, ['message', channel, message]);
        receivers++;
      }
    }
    for (const [pattern, subs] of this.byPattern) {
      if (!stringMatch(pattern, channel)) continue;
      for (const sub of subs) {
        this.deliver(sub, ['pmessage', pattern, channel, message]);
        receivers++;
      }
    }
    return receivers;
  }

  /** PUBSUB CHANNELS: active channels (with at least one subscriber), filtered by a glob. */
  channels(pattern?: string): string[] {
    const all = [...this.byChannel.keys()];
    return pattern === undefined ? all : all.filter((c) => stringMatch(pattern, c));
  }

  /** PUBSUB NUMSUB: direct subscribers of one channel; patterns don't count. */
  numSub(channel: string): number {
    return this.byChannel.get(channel)?.size ?? 0;
  }

  /** PUBSUB NUMPAT: distinct patterns in use, not subscriptions. */
  numPat(): number {
    return this.byPattern.size;
  }

  private add(index: Map<string, Set<S>>, own: Set<string>, sub: S, name: string): boolean {
    if (own.has(name)) return false;
    own.add(name);
    let subs = index.get(name);
    if (subs === undefined) index.set(name, (subs = new Set()));
    subs.add(sub);
    return true;
  }

  private remove(index: Map<string, Set<S>>, own: Set<string>, sub: S, name: string): boolean {
    if (!own.delete(name)) return false;
    const subs = index.get(name)!;
    subs.delete(sub);
    // An empty entry would make PUBSUB CHANNELS list a channel nobody listens on.
    if (subs.size === 0) index.delete(name);
    return true;
  }
}
