/**
 * Error replies: the ReplyError a handler throws and every Redis 7.4 error string (spec 7.4).
 *
 * Key design choice: every message carries its error code as its first word ("ERR …",
 * "WRONGTYPE …"), so a message alone fully determines the reply line and the encoder never
 * has to guess. Strings were checked against the redis:7.4 reference server.
 *
 * Mirrors Redis server.c (createSharedObjects: shared.syntaxerr, shared.wrongtypeerr, …) and
 * the error helpers in networking.c (addReplyErrorArity, addReplySubcommandSyntaxError).
 */

/** Thrown by a handler; the dispatcher turns it into an error reply and nothing has changed. */
export class ReplyError extends Error {
  override name = 'ReplyError';
}

/** A malformed request: the reply is sent, then the connection closes. */
export class ProtocolError extends ReplyError {
  override name = 'ProtocolError';
}

export const ERR = {
  SYNTAX: 'ERR syntax error',
  NOT_INTEGER: 'ERR value is not an integer or out of range',
  // getIntFromObjectOrReply's message for an int64 outside the int range (SELECT 2147483648).
  NOT_INT32: 'ERR value is out of range, value must between -2147483648 and 2147483647',
  NOT_FLOAT: 'ERR value is not a valid float',
  NOT_POSITIVE: 'ERR value is out of range, must be positive',
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
  ZRANGE_WITHSCORES_BYLEX: 'ERR syntax error, WITHSCORES not supported in combination with BYLEX',
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
  EXPIRE_NX_CONFLICT: 'ERR NX and XX, GT or LT options at the same time are not compatible',
  EXPIRE_GT_LT_CONFLICT: 'ERR GT and LT options at the same time are not compatible',
  // Redis's text, "local" mode included, though we only have yes and no.
  DEBUG_NOT_ALLOWED:
    'ERR DEBUG command not allowed. If the enable-debug-command option is set to "local", you can run it from a local connection, otherwise you need to set this option in the configuration file, and then restart the server.',
  INTERNAL: 'ERR internal error',
  NOT_ALLOWED_IN_MULTI: 'ERR Command not allowed inside a transaction',
} as const;

export const PROTOCOL = {
  INVALID_MULTIBULK: 'ERR Protocol error: invalid multibulk length',
  INVALID_BULK: 'ERR Protocol error: invalid bulk length',
  UNBALANCED_QUOTES: 'ERR Protocol error: unbalanced quotes in request',
  TOO_BIG_INLINE: 'ERR Protocol error: too big inline request',
  TOO_BIG_MBULK: 'ERR Protocol error: too big mbulk count string',
  TOO_BIG_BULK: 'ERR Protocol error: too big bulk count string',
  UNAUTH_MULTIBULK: 'ERR Protocol error: unauthenticated multibulk length',
  UNAUTH_BULK: 'ERR Protocol error: unauthenticated bulk length',
  // Redis skips the two bytes after a bulk without looking; spec 10.1 rejects them instead.
  MISSING_CRLF: "ERR Protocol error: expected '\\r\\n' after bulk",
} as const;

export const expectedDollar = (got: string): string =>
  `ERR Protocol error: expected '$', got '${got}'`;

/** Redis formats args with %s, so a NUL byte ends one; we do the same. */
const cString = (s: string): string => {
  const nul = s.indexOf('\0');
  return nul === -1 ? s : s.slice(0, nul);
};

/** At most 128 bytes of args in total, each quoted and followed by a space, as in server.c. */
export const unknownCommand = (argv: readonly string[]): string => {
  let args = '';
  for (let i = 1; i < argv.length && args.length < 128; i++) {
    args += `'${cString(argv[i]!).slice(0, 128 - args.length)}' `;
  }
  const name = cString(argv[0] ?? '').slice(0, 128);
  return `ERR unknown command '${name}', with args beginning with: ${args}`;
};

/** `name` is the lowercase full name, e.g. 'config|get'. */
export const wrongArity = (name: string): string =>
  `ERR wrong number of arguments for '${name}' command`;

export const unknownSubcommand = (sub: string, command: string): string =>
  `ERR unknown subcommand '${cString(sub).slice(0, 128)}'. Try ${command.toUpperCase()} HELP.`;

export const invalidExpireTime = (command: string): string =>
  `ERR invalid expire time in '${command}' command`;

/** EXPIRE's unknown-flag error, the option as the client typed it. */
export const unsupportedOption = (option: string): string =>
  `ERR Unsupported option ${cString(option)}`;

export const subscriberContext = (command: string): string =>
  `ERR Can't execute '${command}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`;

export const misconf = (reason: string): string =>
  `MISCONF Errors writing to the AOF file: ${reason}`;
