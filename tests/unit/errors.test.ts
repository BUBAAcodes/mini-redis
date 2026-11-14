import { describe, expect, it } from 'vitest';
import {
  ERR,
  PROTOCOL,
  ProtocolError,
  ReplyError,
  expectedDollar,
  expectedStar,
  invalidExpireTime,
  misconf,
  subscriberContext,
  unknownCommand,
  unknownSubcommand,
  unsupportedOption,
  wrongArity,
} from '../../src/protocol/errors.js';

describe('error strings (spec 7.4, checked against redis:7.4)', () => {
  it('has every fixed string with its code', () => {
    expect(ERR).toEqual({
      SYNTAX: 'ERR syntax error',
      NOT_INTEGER: 'ERR value is not an integer or out of range',
      NOT_INT32: 'ERR value is out of range, value must between -2147483648 and 2147483647',
      NOT_FLOAT: 'ERR value is not a valid float',
      NOT_POSITIVE: 'ERR value is out of range, must be positive',
      TIMEOUT_NOT_FLOAT: 'ERR timeout is not a float or out of range',
      TIMEOUT_NEGATIVE: 'ERR timeout is negative',
      TIMEOUT_OUT_OF_RANGE: 'ERR timeout is out of range',
      OVERFLOW: 'ERR increment or decrement would overflow',
      NAN_OR_INFINITY: 'ERR increment would produce NaN or Infinity',
      VALUE_NAN_OR_INFINITY: 'ERR value is NaN or Infinity',
      HASH_NOT_INTEGER: 'ERR hash value is not an integer',
      HASH_NOT_FLOAT: 'ERR hash value is not a float',
      ZADD_XX_NX: 'ERR XX and NX options at the same time are not compatible',
      ZADD_GT_LT_NX: 'ERR GT, LT, and/or NX options at the same time are not compatible',
      ZADD_INCR_PAIR: 'ERR INCR option supports a single increment-element pair',
      SCORE_NAN: 'ERR resulting score is not a number (NaN)',
      WEIGHT_NOT_FLOAT: 'ERR weight value is not a float',
      ZRANGE_LIMIT:
        'ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX',
      ZRANGE_WITHSCORES_BYLEX:
        'ERR syntax error, WITHSCORES not supported in combination with BYLEX',
      SRANDMEMBER_RANGE:
        'ERR value is out of range, value must between -9223372036854775807 and 9223372036854775807',
      WRONGTYPE: 'WRONGTYPE Operation against a key holding the wrong kind of value',
      NO_SUCH_KEY: 'ERR no such key',
      INDEX_OUT_OF_RANGE: 'ERR index out of range',
      DB_INDEX_OUT_OF_RANGE: 'ERR DB index is out of range',
      MIN_MAX_NOT_FLOAT: 'ERR min or max is not a float',
      MIN_MAX_NOT_LEX: 'ERR min or max not valid string range item',
      MULTI_NESTED: 'ERR MULTI calls can not be nested',
      EXEC_WITHOUT_MULTI: 'ERR EXEC without MULTI',
      DISCARD_WITHOUT_MULTI: 'ERR DISCARD without MULTI',
      WATCH_INSIDE_MULTI: 'ERR WATCH inside MULTI is not allowed',
      EXECABORT: 'EXECABORT Transaction discarded because of previous errors.',
      NOAUTH: 'NOAUTH Authentication required.',
      WRONGPASS: 'WRONGPASS invalid username-password pair or user is disabled.',
      AUTH_NOT_CONFIGURED:
        'ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?',
      READONLY: "READONLY You can't write against a read only replica.",
      OOM: "OOM command not allowed when used memory > 'maxmemory'.",
      NOPROTO: 'NOPROTO unsupported protocol version',
      MAX_CLIENTS: 'ERR max number of clients reached',
      DECR_OVERFLOW: 'ERR decrement would overflow',
      INVALID_CURSOR: 'ERR invalid cursor',
      OFFSET_OUT_OF_RANGE: 'ERR offset is out of range',
      STRING_TOO_LONG: 'ERR string exceeds maximum allowed size (proto-max-bulk-len)',
      BGSAVE_IN_PROGRESS: 'ERR Background save already in progress',
      BGSAVE_OTHER_JOB:
        "ERR Another child process is active (AOF?): can't BGSAVE right now. Use BGSAVE SCHEDULE in order to schedule a BGSAVE whenever possible.",
      AOF_REWRITE_IN_PROGRESS: 'ERR Background append only file rewriting already in progress',
      AOF_REWRITE_FAILED:
        "ERR Can't execute an AOF background rewriting. Please check the server logs for more information.",
      EXPIRE_NX_CONFLICT: 'ERR NX and XX, GT or LT options at the same time are not compatible',
      EXPIRE_GT_LT_CONFLICT: 'ERR GT and LT options at the same time are not compatible',
      DEBUG_NOT_ALLOWED:
        'ERR DEBUG command not allowed. If the enable-debug-command option is set to "local", you can run it from a local connection, otherwise you need to set this option in the configuration file, and then restart the server.',
      INTERNAL: 'ERR internal error',
      NOT_ALLOWED_IN_MULTI: 'ERR Command not allowed inside a transaction',
      AOF_LOAD_FAILED: 'ERR Error trying to load the AOF files, check server logs.',
      RDB_LOAD_FAILED: 'ERR Error trying to load the RDB dump, check server logs.',
      BARE: 'ERR',
    });
  });

  it('has every protocol error', () => {
    expect(PROTOCOL).toEqual({
      INVALID_MULTIBULK: 'ERR Protocol error: invalid multibulk length',
      INVALID_BULK: 'ERR Protocol error: invalid bulk length',
      UNBALANCED_QUOTES: 'ERR Protocol error: unbalanced quotes in request',
      TOO_BIG_INLINE: 'ERR Protocol error: too big inline request',
      TOO_BIG_MBULK: 'ERR Protocol error: too big mbulk count string',
      TOO_BIG_BULK: 'ERR Protocol error: too big bulk count string',
      UNAUTH_MULTIBULK: 'ERR Protocol error: unauthenticated multibulk length',
      UNAUTH_BULK: 'ERR Protocol error: unauthenticated bulk length',
      MISSING_CRLF: "ERR Protocol error: expected '\\r\\n' after bulk",
    });
    expect(expectedDollar(':')).toBe("ERR Protocol error: expected '$', got ':'");
    expect(expectedStar('g')).toBe("ERR Protocol error: expected '*', got 'g'");
  });

  it('formats unknown command like Redis, trailing space included', () => {
    expect(unknownCommand(['foo', 'a', 'b'])).toBe(
      "ERR unknown command 'foo', with args beginning with: 'a' 'b' ",
    );
    expect(unknownCommand(['foo'])).toBe("ERR unknown command 'foo', with args beginning with: ");
    expect(unknownCommand([''])).toBe("ERR unknown command '', with args beginning with: ");
  });

  it('truncates unknown command args at 128 bytes, as the reference does', () => {
    // From redis:7.4: one 200-byte arg is cut to 128 and nothing follows it.
    expect(unknownCommand(['FOO', 'x'.repeat(200), 'b'])).toBe(
      `ERR unknown command 'FOO', with args beginning with: '${'x'.repeat(128)}' `,
    );
    // 100 a's use 103 bytes ("'…' "), so the next arg gets the remaining 25.
    expect(unknownCommand(['FOO', 'a'.repeat(100), 'b'.repeat(100), 'c'])).toBe(
      `ERR unknown command 'FOO', with args beginning with: '${'a'.repeat(100)}' '${'b'.repeat(25)}' `,
    );
    expect(unknownCommand(['F'.repeat(200)])).toBe(
      `ERR unknown command '${'F'.repeat(128)}', with args beginning with: `,
    );
  });

  it('cuts args at a NUL byte, as C string formatting does', () => {
    expect(unknownCommand(['FOO', 'a\0b'])).toBe(
      "ERR unknown command 'FOO', with args beginning with: 'a' ",
    );
  });

  it('formats arity, subcommand and per-command errors', () => {
    expect(wrongArity('get')).toBe("ERR wrong number of arguments for 'get' command");
    expect(wrongArity('config|get')).toBe("ERR wrong number of arguments for 'config|get' command");
    expect(unknownSubcommand('foo', 'config')).toBe(
      "ERR unknown subcommand 'foo'. Try CONFIG HELP.",
    );
    expect(unknownSubcommand('x'.repeat(200), 'client')).toBe(
      `ERR unknown subcommand '${'x'.repeat(128)}'. Try CLIENT HELP.`,
    );
    expect(invalidExpireTime('set')).toBe("ERR invalid expire time in 'set' command");
    expect(unsupportedOption('Bogus')).toBe('ERR Unsupported option Bogus');
    expect(unsupportedOption('a\0b')).toBe('ERR Unsupported option a');
    expect(subscriberContext('get')).toBe(
      "ERR Can't execute 'get': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context",
    );
    expect(misconf('No space left on device')).toBe(
      'MISCONF Errors writing to the AOF file: No space left on device',
    );
  });

  it('ProtocolError is a ReplyError the dispatcher can tell apart', () => {
    const e = new ProtocolError(PROTOCOL.INVALID_BULK);
    expect(e).toBeInstanceOf(ReplyError);
    expect(e).toBeInstanceOf(ProtocolError);
    expect(e.message).toBe(PROTOCOL.INVALID_BULK);
    expect(new ReplyError(ERR.SYNTAX)).not.toBeInstanceOf(ProtocolError);
  });
});
