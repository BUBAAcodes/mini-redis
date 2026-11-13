# Step 17: Pub/sub

## What this step built

`src/pubsub/hub.ts` is a two-way registry of channels and glob patterns. `src/commands/pubsub.ts` holds SUBSCRIBE, PSUBSCRIBE, UNSUBSCRIBE, PUNSUBSCRIBE, PUBLISH and PUBSUB CHANNELS | NUMSUB | NUMPAT. Each `Client` keeps its own `channels` and `patterns` sets, and the dispatcher refuses everything but the subscriber commands to a RESP2 client that has any. PUBLISH propagates a `replicasOnly` record, which is new on `PropagationRecord`, so the AOF will skip it and the replicas will get it.

## One real command's path

Client S runs `SUBSCRIBE news` and `PSUBSCRIBE n*`; client P runs `PUBLISH news hi`:

1. `SUBSCRIBE news` goes through `dispatch` (`dispatch.ts:67`) and `call` to `subscribeCommand` (`pubsub.ts:19`). `hub.subscribe` (`hub.ts:43`) adds `news` to `S.channels` and S to `byChannel['news']` (`add`, `hub.ts:105`). The confirmation `["subscribe","news",1]` is written with `reply.push`, a plain array in RESP2 and a `>` frame in RESP3.
2. `PSUBSCRIBE n*` does the same into `S.patterns` and `byPattern`, and replies with count 2.
3. S's next command passes through the subscriber check (`dispatch.ts:73`). `inSubscriberMode` (`hub.ts:26`) is true, so anything but the six allowed commands gets `subscriberContext` (`errors.ts:123`).
4. P's `PUBLISH news hi` runs `publishCommand` (`pubsub.ts:61`), which calls `hub.publish` (`hub.ts:70`). That delivers `["message","news","hi"]` to S, then `["pmessage","n*","news","hi"]` for the matching pattern, so the reply is 2.
5. Delivery is the callback in `server.ts:78`: it appends the frame to S's `Reply` and calls `queueReply`. So `beforeSleep` writes the frame in S's next batch.
6. `alsoPropagate(argv, true)` (`pubsub.ts:63`, `propagate.ts:66`) emits `{ db, argv, replicasOnly: true }` even though nothing changed.

When S disconnects, `freeClient` calls `pubsub.unsubscribeAll` (`server.ts:249`).

## Key functions and why each exists

- **`PubSubHub.publish` (`hub.ts:70`)**: the whole fan-out. Channel subscribers first, then every pattern that matches, in subscription order, as in Redis's `pubsubPublishMessage`.
- **`add` / `remove` (`hub.ts:105`, `:114`)**: keep both halves of the registry in step, and delete empty entries so `PUBSUB CHANNELS` and `NUMPAT` never list ghosts.
- **`inSubscriberMode` (`hub.ts:26`)**: RESP2 only. A RESP2 subscriber can't tell a reply from a message, so its commands are limited. RESP3 has real push frames, so nothing is limited.
- **`pingCommand` (`connection.ts:23`)**: in subscriber mode PING replies `["pong", arg or ""]`, so it can't be mistaken for a `+PONG`.
- **`unsubscribeCommand` (`pubsub.ts:34`)**: no arguments means every channel, one reply each, counting down. With nothing subscribed it still sends one reply, `["unsubscribe", nil, 0]`.
- **The `replicasOnly` flag (`propagate.ts:31`)**: PUBLISH changes no data, so the dispatcher wouldn't propagate it. The flag lets the AOF sink skip the record and the replication sink (step 20) keep it, without a second path that could reorder it.

## Trade-offs, and what Redis does differently

- **Registry shape.** The hub is two `Map`s of `Set`s, plus the per-client sets. Redis (`pubsub.c`) keeps a dict of channel → list of clients and a per-client dict. The pattern list is scanned in full on every PUBLISH, in Redis too.
- **Order of a bare UNSUBSCRIBE.** We go in subscription order. Redis walks a dict, so its order is arbitrary.
- **Unbuilt.** Sharded pub/sub and PUBSUB HELP are a row in `docs/DIFFERENCES.md`. The pubsub output-buffer limit (spec 9.11 item 6) and RESET are step 22.
- **Legacy error.** `PUBSUB CHANNELS a b` gets `unknown subcommand or wrong number of arguments for 'CHANNELS'. Try PUBSUB HELP.`, as the reference does. It is found by comparing against `redis:7.4`.
- **Propagation.** Redis uses `forceCommandPropagation(PROPAGATE_REPL)` in `publishCommand`; our flag on the record plays the same role.

Tests: `tests/unit/pubsub-hub.test.ts` (registry, counts, overlap, cleanup), `tests/unit/propagate.test.ts` (the marker), and `tests/integration/pubsub.test.ts` (exact bytes, subscriber mode, RESP3 frames, PUBSUB, disconnect cleanup, propagation, and an ioredis subscriber). 28 command sequences were compared byte for byte with the reference; the one diff, the legacy error, is fixed. Two `redis-cli` terminals (SUBSCRIBE and PSUBSCRIBE) both got the message.

## The single most important line

`dispatch.ts:73`: `if (inSubscriberMode(client) && !SUBSCRIBER_COMMANDS.has(top.name))`. Deleting it fails "refuses other commands with the subscriber-mode error" and "returns to normal mode once the last subscription is gone" in `tests/integration/pubsub.test.ts`.

## Quiz

1. A client is subscribed to `c` and to the pattern `c*`. Another client publishes to `c`. What does PUBLISH reply, and how many frames does the subscriber get?
2. Why does a client's `UNSUBSCRIBE` with no arguments and no subscriptions still send a reply?
3. Why does PUBLISH call `alsoPropagate` instead of relying on the `write` flag?

<details>
<summary>Answers</summary>

1. 2, and two frames: a `message` from the channel, then a `pmessage` from the pattern. The count is per message sent (`hub.publish`, `hub.ts:70`), not per client.
2. In RESP2 the client is waiting for a reply to every command it sends. Redis sends `["unsubscribe", nil, 0]`, and clients such as ioredis rely on exactly one reply per name.
3. PUBLISH isn't a write: it never grows `server.dirty`, so `call` wouldn't propagate it. Replicas still need it so their own subscribers hear it. The record is marked `replicasOnly` so the AOF never stores a message.

</details>
