# Step 05: Server, clients and dispatcher

## What this step built

MiniRedis is now a real TCP server. `redis-cli`, `redis-benchmark` and ioredis work against it, with PING, ECHO, QUIT, SELECT, GET, SET, DEL, COMMAND, CONFIG, CLIENT, TIME and a minimal INFO. Underneath are the pieces every later step plugs into: the config table (`src/config.ts`), the `Server` and its clients, the dispatcher with Redis's check order, a first `Db` (the one door to keys), the propagation path with no sinks attached yet, and `beforeSleep`, which sends each client's replies in one write per event-loop turn. `src/index.ts` reads a config file and `--flags` the way `redis-server` does, and shuts down cleanly on SIGTERM.

## One real command's path

`redis-cli set user:1 alice`:

1. The socket's `data` event (`server.ts:190`) calls `onData()` (`:196`). That feeds the chunk to the client's own `RespParser` (`:199`), then calls `processInput()` (`:204`).
2. `parser.next()` (`parser.ts:90`) returns `{ argv: ['set', 'user:1', 'alice'] }`, and `processInput` calls `dispatch()` (`server.ts:210`).
3. `dispatch()` (`dispatch.ts:25`) finds `set` in this server's table (`:29`) and checks the arity, `-3` (`:35`). Then `call()` (`:57`) reads the clock into `server.cmdTime` (`:63`) and runs the handler (`:66`).
4. `setCommand()` (`strings.ts:22`) calls `lookupWrite` (`:28`), which is where lazy expiry and copy-on-write will hook in later. Then `setKey` (`database.ts:72`) stores the object, `signalModifiedKey` (`database.ts:90`) bumps `server.dirty`, and `+OK` is appended to the client's `Reply` (`strings.ts:31`).
5. Back in `call()`, `dirty` grew and SET is a `write`, so `propagator.end()` (`propagate.ts:72`) emits `{ db: 0, argv }` to every attached sink (`dispatch.ts:84-85`).
6. `processInput` queues the client (`server.ts:229`). `scheduleBeforeSleep()` (`event-loop.ts:20`) arms one `setImmediate` (`:23`), and `beforeSleep()` (`:38`) writes the queued bytes between `cork()` and `uncork()` (`:54-55`).

## Key functions and why each exists

- **`Config` / `DIRECTIVES` (`config.ts`)**: one table with each directive's default, whether it's mutable, a parser and a formatter. Defaults, the config file, flags and CONFIG SET all go through the same parser. `setMany()` parses every pair before it assigns any, so a bad pair changes nothing (rule 4). The error texts were copied from redis:7.4.
- **`dispatch()` / `call()`**: the 9.1 order. Rejections (unknown command, arity, subcommand) happen before the handler, so an error reply means nothing changed. The comment at `dispatch.ts:51` reserves the slots for AUTH, subscriber mode, MULTI, READONLY and OOM. A non-`ReplyError` exception is logged with its stack and answered with `-ERR internal error`.
- **`CommandSpec` and `command()` (`command.ts`)**: subcommands are full specs named `config|get`, so arity errors read `'config|get'` and COMMAND INFO lists them, just like Redis 7. These types live apart from `registry.ts` so the command modules don't import the table that imports them.
- **`Propagator`**: records per command. `rewritePropagation` replaces the record, `alsoPropagate` emits records instead of it, `preventPropagation` drops it, and `propagateNow` lets step 7's lazy-expiry DEL go out first.
- **`EventLoop.beforeSleep()`**: the one place replies leave. See ADR 0003.
- **`Db`**: `lookupRead` counts hits and misses and touches the LRU clock; `peek` and `lookupWrite` don't count. `cron()` gives each db 1 ms of rehashing per tick.
- **`stringMatch()` (`utils/glob.ts`)**: a faithful port of `stringmatchlen`, quirks included, built now because CONFIG GET needs it. `utils/numbers.ts` has just `parseInt64` so far.

## Trade-offs, and what Redis does differently

- Redis's reply buffer (`networking.c`, `_addReplyToBuffer`) is a 16 KB static buffer plus a list of blocks. Ours is an array of strings joined once per turn. If the kernel won't take everything, Node keeps the rest in userland, so the output limits (step 22) must watch `socket.writableLength` as well as `Reply`.
- Redis's `alsoPropagate()` (`server.c`) adds a record, and handlers must also call `preventCommandPropagation()`. Spec 9.5 lists the helpers as "unless", so here `alsoPropagate` replaces the record.
- Redis checks the query buffer limit in `readQueryFromClient` before parsing. We check after the parse loop, so a big pipeline that has fully arrived is never counted against the limit.
- Redis's `config.c` applies each value with an apply function and rolls back on failure. No apply step can fail yet, so we parse everything first and then assign.
- COMMAND INFO's ACL categories and key specs are derived from our flags (`docs/DIFFERENCES.md`).

## The single most important line

`database.ts:91`, `this.server.dirty++;` inside `signalModifiedKey`. It's how a write says "I changed data". Delete it and the dispatcher treats every write as a no-op, so nothing is propagated: `propagation.test.ts` "propagates a write as it arrived" fails. So do the dirty-counter tests in `strings-keys.test.ts` and `database.test.ts`. Save points (step 13) would never fire either.

## Quiz

1. Why does QUIT set `closeAfterReply` instead of closing the socket?
2. A client pipelines `SET a 1`, `DEL nosuch`, `GET a`, `SET a 1 bogus`. What reaches a propagation sink, and why?
3. Why does `scheduleBeforeSleep()` use `setImmediate` and not `process.nextTick`?

<details>
<summary>Answers</summary>

1. Replies for the commands before QUIT are still sitting in the client's `Reply`. They only reach the socket in `beforeSleep`, so closing at once would drop them along with QUIT's `+OK`. The flag also stops `processInput` from running anything pipelined after QUIT: the `SET quit 1` in `connection.test.ts` never runs.
2. Only `SET a 1`. `DEL nosuch` is a write, but it deleted nothing, so `dirty` didn't grow. `GET` isn't a write. `SET a 1 bogus` fails its syntax check before changing anything, so `dirty` didn't grow there either.
3. `nextTick` callbacks run as soon as the current `data` callback returns, before Node delivers the other sockets that were readable in the same turn. Every socket would get its own flush (and, from step 12, its own AOF write). `setImmediate` runs in the check phase, after the whole poll phase, so one `beforeSleep` covers the whole turn.

</details>
