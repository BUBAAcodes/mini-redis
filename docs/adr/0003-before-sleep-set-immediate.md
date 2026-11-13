# ADR 0003: beforeSleep runs from one setImmediate per loop turn

**Status:** accepted (step 5)

## Context

Redis does two things once per event-loop turn, just before it waits for I/O again, in `beforeSleep()` (`server.c`). It writes the AOF buffer, and then it sends every client's queued replies (`handleClientsWithPendingWrites`, `networking.c`). That order is what makes rule 8 true ("write before you reply"). It also means a client that pipelined a thousand commands gets them all back in one `write`.

Node has no "about to sleep" hook. Writing each reply to the socket the moment a handler produces it would cost a syscall per command, and the AOF could never be written once before all of them. `process.nextTick` and microtasks run before Node returns to the poll phase, so they would fire once per `data` callback, not once per turn. Other sockets that were readable in the same turn would then each get their own flush, and later their own AOF write.

## Decision

Handlers only append to the client's `Reply` (its output queue). Any code that queues a reply or a propagation record calls `scheduleBeforeSleep()` (`src/server/event-loop.ts`), which arms a `setImmediate` if one isn't already pending. `setImmediate` callbacks run in the check phase, right after the poll phase that delivered this turn's socket data. So one `beforeSleep()` sees every command run in the turn. It writes the AOF (step 12), then the replication stream (step 20), then each client's queued replies as one write between `cork()` and `uncork()`, and finally closes clients marked close-after-reply.

## Consequences

- One write per client per turn, whatever the pipeline depth. `tests/integration/connection.test.ts` counts the writes for a 1,000-command pipeline: there is exactly one.
- The AOF write in step 12 slots in before the reply loop, and rule 8 holds by construction.
- A command's reply goes out on the same turn it ran. Nothing waits for a timer, so latency doesn't grow.
- Timers and cron run in other phases. They must call `scheduleBeforeSleep()` themselves when they queue anything (a timed-out BLPOP, a replica PING), or their output waits for the next socket event.
- Replies are built as strings and joined once per turn. A client that asks for a huge reply holds it all in memory until beforeSleep. The output buffer limits (step 22) are enforced at that point.
