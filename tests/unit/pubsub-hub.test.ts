import { describe, expect, it } from 'vitest';
import { PubSubHub } from '../../src/pubsub/hub.js';
import type { Subscriber } from '../../src/pubsub/hub.js';
import type { ReplyItem } from '../../src/protocol/encoder.js';

interface Fake extends Subscriber {
  name: string;
}
const fake = (name: string): Fake => ({ name, channels: new Set(), patterns: new Set() });

const setup = () => {
  const delivered: [string, readonly ReplyItem[]][] = [];
  const hub = new PubSubHub<Fake>((sub, frame) => delivered.push([sub.name, frame]));
  return { hub, delivered };
};

describe('PubSubHub (spec 9.11)', () => {
  it('counts channels and patterns together per client', () => {
    const { hub } = setup();
    const a = fake('a');
    expect(hub.subscribe(a, 'c1')).toBe(true);
    expect(hub.psubscribe(a, 'p*')).toBe(true);
    expect(hub.count(a)).toBe(2);
  });

  it('treats a repeated subscription as no change', () => {
    const { hub } = setup();
    const a = fake('a');
    hub.subscribe(a, 'c');
    expect(hub.subscribe(a, 'c')).toBe(false);
    expect(hub.count(a)).toBe(1);
    expect(hub.unsubscribe(a, 'missing')).toBe(false);
  });

  it('delivers a message to channel subscribers, then a pmessage per matching pattern', () => {
    const { hub, delivered } = setup();
    const a = fake('a');
    const b = fake('b');
    hub.subscribe(a, 'news');
    hub.psubscribe(b, 'n*');
    hub.psubscribe(b, 'ne?s');
    hub.psubscribe(b, 'x*');
    expect(hub.publish('news', 'hi')).toBe(3);
    expect(delivered).toEqual([
      ['a', ['message', 'news', 'hi']],
      ['b', ['pmessage', 'n*', 'news', 'hi']],
      ['b', ['pmessage', 'ne?s', 'news', 'hi']],
    ]);
  });

  it('counts a client once per matching subscription (channel plus pattern = 2)', () => {
    const { hub } = setup();
    const a = fake('a');
    hub.subscribe(a, 'c');
    hub.psubscribe(a, 'c*');
    expect(hub.publish('c', 'm')).toBe(2);
  });

  it('delivers nothing to a channel nobody listens on', () => {
    const { hub, delivered } = setup();
    expect(hub.publish('void', 'm')).toBe(0);
    expect(delivered).toEqual([]);
  });

  it('matches channels as bytes, case-sensitively', () => {
    const { hub } = setup();
    const a = fake('a');
    hub.psubscribe(a, 'N*');
    expect(hub.publish('news', 'm')).toBe(0);
    expect(hub.publish('News', 'm')).toBe(1);
  });

  it('forgets empty channels and patterns', () => {
    const { hub } = setup();
    const a = fake('a');
    hub.subscribe(a, 'c');
    hub.psubscribe(a, 'p*');
    expect(hub.channels()).toEqual(['c']);
    expect(hub.numPat()).toBe(1);
    hub.unsubscribe(a, 'c');
    hub.punsubscribe(a, 'p*');
    expect(hub.channels()).toEqual([]);
    expect(hub.numPat()).toBe(0);
  });

  it('numPat counts distinct patterns, not subscriptions', () => {
    const { hub } = setup();
    hub.psubscribe(fake('a'), 'p*');
    hub.psubscribe(fake('b'), 'p*');
    expect(hub.numPat()).toBe(1);
  });

  it('lists channels, optionally filtered by a glob, and counts subscribers', () => {
    const { hub } = setup();
    const a = fake('a');
    const b = fake('b');
    hub.subscribe(a, 'foo');
    hub.subscribe(b, 'foo');
    hub.subscribe(a, 'bar');
    hub.psubscribe(b, 'f*');
    expect(hub.channels().sort()).toEqual(['bar', 'foo']);
    expect(hub.channels('f*')).toEqual(['foo']);
    expect(hub.numSub('foo')).toBe(2);
    expect(hub.numSub('missing')).toBe(0);
  });

  it('unsubscribeAll removes a client from everything', () => {
    const { hub } = setup();
    const a = fake('a');
    hub.subscribe(a, 'c');
    hub.psubscribe(a, 'p*');
    hub.unsubscribeAll(a);
    expect(hub.count(a)).toBe(0);
    expect(hub.publish('c', 'm')).toBe(0);
    expect(hub.numPat()).toBe(0);
  });
});
