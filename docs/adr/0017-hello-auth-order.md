# ADR 0017: HELLO validates everything before it changes anything

**Status:** accepted (step 22)

## Context

Rule 4 says a command that replies with an error changes nothing. HELLO is the one command that can do three things at once: switch the protocol, authenticate and set the client name, and a connection library sends all three on connect (`HELLO 3 AUTH user pass SETNAME name`). If it failed halfway, a client could be left authenticated but on the wrong protocol, or named but not authenticated.

The order of the checks is visible to clients, so it has to match Redis. The reference server (7.4) answers, in this order: an unparsable version (`ERR Protocol version is not an integer or out of range`), a version other than 2 or 3 (`-NOPROTO`), a bad option (`ERR Syntax error in HELLO option '…'`), a bad client name, wrong credentials (`-WRONGPASS`), and, for an unauthenticated client with no AUTH option, `-NOAUTH HELLO must be called with the client already authenticated…`. Probing it showed two things that are easy to get wrong. The name is checked ahead of the credentials: `HELLO 3 AUTH default wrongpass SETNAME "a b"` reports the name. And a failing HELLO authenticates nobody: after `HELLO 3 AUTH default <right password> SETNAME "a b"` the connection still gets `-NOAUTH`.

## Decision

`helloCommand` (`src/commands/connection.ts`) runs all of those checks in that order and only then changes state: authentication, the name and the protocol, in that order, none of which can fail. Nothing is applied while an error is still possible, so rule 4 holds for the connection state as well as for the keyspace.

## Consequences

- `tests/integration/auth.test.ts` pins the replies as bytes taken from the reference, including the three orderings above. The differential suite can't judge HELLO itself, because its reply carries a client id and a patch version (`docs/DIFFERENCES.md`).
- Redis applies the checks in whatever order its C code happens to do them. If a later Redis changes that order, this ADR and those tests are where to look.
