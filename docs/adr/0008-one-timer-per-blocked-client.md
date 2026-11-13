# ADR 0008: One Node timer per blocked client

**Status:** accepted (step 18)

## Context

A BLPOP, BRPOP or BLMOVE that finds nothing waits until data arrives or its timeout passes (spec 9.12). Redis keeps every blocked client with a timeout in one radix tree ordered by deadline (`server.clients_timeout_table`, `timeout.c`). Each turn of its event loop, `handleBlockedClientsTimeout` pops the expired ones from the front, so finding them costs O(log n) per client and nothing for clients still waiting. Redis needs its own structure because its event loop has only one timer of its own.

Node already keeps every timer in a priority structure ordered by deadline (lists per duration, inside a binary heap, in `lib/internal/timers.js`), and runs a callback when its deadline passes.

## Decision

Each blocked client with a non-zero timeout gets one `setTimeout`, stored in its `BlockState` (`src/blocking/waiters.ts`). It is cleared when the client is served, times out, or disconnects. When it fires, the client gets a null array, is unblocked, and its buffered input is queued for the next beforeSleep. The timer is `unref()`ed, so a parked client never keeps a process alive by itself.

Node caps a delay at 2^31−1 ms (about 24.8 days). A longer delay fires after 1 ms, with only a warning. So the delay is `min(deadline − now, 2^31−1)` (`timerDelay`), and a timer that fires before its deadline re-arms for the rest.

## Consequences

- No timeout code in serverCron and no second ordered structure to keep in step. A client's timeout fires on time instead of at the next cron tick: the 0.1-second test sees about 100 ms, not up to 100 ms + 1/hz.
- One timer object per blocked client. Ten thousand parked clients means ten thousand timers. Node handles that well, because timers sharing a duration share one list.
- A timer callback runs outside any command, so it must do a command's chores itself: count the call for stats, queue the reply, and schedule beforeSleep (`Server.queueUnblocked`).
- A timed-out client's pipelined input runs from beforeSleep (`processUnblockedClients`), never from inside the timer callback or another client's command, so commands never nest.
- The deadline is read with `Date.now()`, and Node's timers use a monotonic clock. So a wall-clock jump can make a timer fire early; it then just re-arms for the time that's left.
