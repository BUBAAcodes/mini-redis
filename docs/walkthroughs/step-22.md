# Step 22: RESP3, auth and limits

## What this step built

A client can now be made to prove who it is and to behave. `requirepass` makes every new connection unauthenticated until `AUTH` or `HELLO … AUTH` succeeds, and `HELLO` also switches a connection to RESP3, whose replies (maps, sets, doubles, nulls, pushes) were already built by the encoder and are now checked end to end. `maxclients`, the idle `timeout` and the output buffer limits for `normal` and `pubsub` clients (the `replica` class existed since step 20) keep one bad client from costing the others. The fuzzer feeds the server hostile bytes and asserts that it never crashes, hangs or leaks.

## One real command's path

A client connects to a server with `requirepass secret`, sends `GET k`, then `HELLO 3 AUTH default secret`:

1. `Server.accept` (`src/server/server.ts:406`) checks `maxclients` (`:413`), then creates the `Client` and sets `authenticated` to `requirepass === ''` (`:426`). The parser limits for unauthenticated clients (10 arguments, 16 KB bulks) read that flag through `authRequired`.
2. `GET k` reaches `processInput` (`server.ts:443`) and `dispatch` (`src/commands/dispatch.ts:60`). The lookup and arity checks pass, then `!client.authenticated && !spec.flags.includes('noauth')` (`dispatch.ts:94`) rejects it with `-NOAUTH Authentication required.`. It happens before the OOM, READONLY and MULTI checks, as in Redis.
3. `HELLO` carries the `noauth` flag, so it gets through to `helloCommand` (`src/commands/connection.ts:145`). The version and options are parsed, the name is validated (`:171`), and `credentialsOk` (`:117`) compares SHA-256 digests with `timingSafeEqual`. Only after every check passes does it set `authenticated` (`:179`), the name and `reply.resp`.
4. `ctx.reply.map(...)` writes `%7` because `resp` is now 3 (`src/protocol/encoder.ts:85`); the same call in RESP2 writes a 14-element array.
5. In `beforeSleep` (`src/server/event-loop.ts:65`), the reply is written, and then `afterWrite` (`event-loop.ts:69`) measures what the socket couldn't take. A client that doesn't read is closed there (`src/server/limits.ts:33`).

## Key functions and why each exists

- **`credentialsOk`** (`connection.ts:117`): one check for `AUTH` and `HELLO AUTH`. Hashing both sides first makes `timingSafeEqual`'s equal-length rule irrelevant and hides the password length. The user and password comparisons both always run.
- **`helloCommand`** (`connection.ts:145`): validates everything in the order the reference server does, and changes state only at the end (ADR 0017). A failing HELLO leaves the connection as it was.
- **`resetCommand`** (`connection.ts:197`): back to a just-connected client. It is in `RUN_INSIDE_MULTI` (`dispatch.ts:59`) and in the subscriber commands (`dispatch.ts:48`), which is why the subscriber error text lists it.
- **`enforceOutputLimit`** (`limits.ts:33`): the hard and soft limit rule, shared by ordinary clients and by the replicas of step 20 (`Replication.checkOutputLimits`).
- **`clientsCron`** (`limits.ts:81`): once a second, the idle timeout (`closeIfIdle`, `:70`) and the soft limits.
- **`EventLoop.afterWrite`** (`event-loop.ts:27`): the hook that lets the server look at a client right after its write (ADR 0016).
- **`tests/fuzz/inputs.ts`**: every case is a function of `(SEED, index)`, so one failing case replays alone with `SEED=… CASE=…`.

## Trade-offs, and what Redis does differently

- **Limits are checked per turn, not per reply.** Redis closes a client the moment a reply pushes it over (`networking.c`: `closeClientOnOutputBufferLimitReached`, called from `_addReplyProtoToList`). Our replies sit in the `Reply` until `beforeSleep`, so we check after the write. See `docs/DIFFERENCES.md` for what that allows.
- **One user.** Redis checks credentials against ACL users (`acl.c`: `ACLAuthenticateUser`). We accept the user `default` and the single `requirepass`.
- **The reference decides the order of HELLO's checks.** We probed Redis 7.4 rather than reading C from memory, and found two surprises (name before credentials; a failing HELLO authenticates nobody).
- **The fuzzer is open loop.** A case ends after 15 ms of silence, whether or not the server has got to it. Too many at once overflow the kernel's accept queue (`ListenOverflows`) and the SYNs are dropped, which looks like a hang. 16 at a time stays inside what the server accepts per second, and a case that can't connect is retried once.
- **RESP3 needed no handler changes.** The audit found no differences: the differential run in `PROTO=3` mode and the scripted shapes test (`tests/differential/differential.test.ts`) match the reference byte for byte.

## The single most important line

`dispatch.ts:94`: `if (!client.authenticated && !spec.flags.includes('noauth'))`. This is the only place that turns a connection's authentication state into a refusal. If it is deleted, a client on a password-protected server can run any command. "refuses everything but AUTH, HELLO, QUIT and RESET until it succeeds" in `tests/integration/auth.test.ts` fails (checked by removing it).

## Quiz

1. `HELLO 3 AUTH default secret SETNAME "a b"` fails. Is the connection authenticated afterwards, and in which protocol? Why do both answers matter for rule 4?
2. A subscriber never reads, and the `pubsub` hard limit is 4 MB. Why is checking the limit inside `PUBLISH` not enough in this design, and where is it checked instead?
3. Why does `AUTH default` (one argument after the command name) get `-WRONGPASS` instead of being read as "user default"?

<details>
<summary>Answers</summary>

1. No, and RESP2. HELLO validates the name before the credentials and changes state only once nothing can fail (ADR 0017), so a failing HELLO changes nothing: not the authentication, not the protocol, not the name. Otherwise a failed command would leave a half-applied connection, which is what rule 4 forbids.
2. `PUBLISH` only appends a frame to the subscriber's `Reply`; the bytes that pile up are in Node's socket queue (`writableLength`) after `beforeSleep` has written them, and `PUBLISH` can't see that. The limit is checked in `afterWrite`, right after each client's write (`event-loop.ts:69`), and the soft limit by `clientsCron` once a second.
3. `AUTH` takes either `AUTH password` or `AUTH user password`. With two words the one after the name is the password, whatever it says, so `default` is tried as a password and fails against `secret`. Redis does the same.

</details>
