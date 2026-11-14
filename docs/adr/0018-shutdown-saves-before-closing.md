# ADR 0018: shutdown does everything that can fail before it closes anything

**Status:** accepted (step 23)

## Context

SHUTDOWN, SIGTERM and SIGINT must leave a loadable snapshot when save points exist (spec 9.14), and a failed save must not lose the data: Redis stays up and says so (`-ERR Errors trying to SHUTDOWN. Check logs.`). Our `Server.close()` already stops the listener, writes and fsyncs the AOF, and closes every socket, but it can't be undone and it never saved.

## Decision

`shutdownServer` (`src/server/shutdown.ts`) runs the fallible steps first, with the server fully up: abort the snapshot job, fsync the AOF, then a synchronous SAVE unless `NOSAVE` (or no save points and no `SAVE`). If the SAVE fails it returns false and nothing has been closed. Only then does it call `close()`, log the goodbye and call `server.exit(0)`. `close()` itself still never saves, so tests that stop a server don't write snapshots. The exit is a hook (`ServerOptions.exit`), like `fatal`, so tests can observe the code without ending the test process. A successful SHUTDOWN sends no reply, as in Redis: the client sees its connection close.

## Consequences

- A signal during a failing disk keeps the server serving, and a second signal tries again (`index.ts` clears its `stopping` flag).
- SAVE runs on the one thread and blocks, which is what SHUTDOWN is for (rule 10).
- No wait for replicas to catch up (`shutdown-timeout`); see `docs/DIFFERENCES.md`.
