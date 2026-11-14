# ADR 0016: output buffer limits are checked after the write, on what Node still holds

**Status:** accepted (step 22)

## Context

A client that stops reading must not be able to make the server hold its replies forever (rule 11, spec 12). The spec gives three classes of limit (`normal`, `replica`, `pubsub`), each with a hard limit and a soft limit that must be exceeded for a number of seconds. A subscriber is the usual victim: PUBLISH queues a frame for it every time, and nothing in the command that queues it can tell the client is stuck.

Redis checks at the moment a reply is appended (`closeClientOnOutputBufferLimitReached` in `_addReplyProtoToList`) and measures the memory of the client's reply list. Our replies work differently (ADR 0003): a handler appends to the client's `Reply`, and `beforeSleep` turns that into one `socket.write`. Once it is written, the bytes the kernel could not take wait in Node's own write queue, `socket.writableLength`. That queue is where a stuck client's output piles up, and it is invisible to the `Reply`.

## Decision

A client's output is `reply.pendingBytes + socket.writableLength` (`outputBytes` in `src/server/limits.ts`). `EventLoop.beforeSleep` calls an `afterWrite` hook for each client right after writing it, and the hook runs `checkOutputLimits`. A client over its hard limit is closed with `killClient` in that same turn, which destroys the socket and frees what Node had queued. Soft limits need a clock, so `Cron` runs `clientsCron` once a second; it starts the soft timer, and closes the client once it has been over for its seconds. A replica is measured by the primary, which also counts its own stream queue (`Replication.outputBytes`), but it applies the limit through the same function, `enforceOutputLimit`.

## Consequences

- A stuck subscriber is cut off in the turn it crosses the limit. `tests/integration/limits.test.ts` publishes up to 200 MB at a subscriber that never reads, with a 4 MB hard limit: the queue peaks at the limit plus one message, and `arrayBuffers` grows by far less than the 200 MB sent.
- The limit is checked once per turn, not once per reply, so one turn's output can pass it before the client is closed. For one client that is bounded by the input read in that turn. This is in `docs/DIFFERENCES.md`.
- `normal` clients have no limit by default (`normal 0 0 0`, as in Redis), so a client can still ask for a huge range and wait for it. Rule 10 allows that.
- A client we never write to (nothing queued) is never visited by the hook; `clientsCron` covers it, so a soft limit still fires when the publisher goes quiet.
