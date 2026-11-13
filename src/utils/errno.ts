/**
 * strerror() for Node's system errors: the text Redis puts in log lines and in -MISCONF, from
 * the error's code (`ENOSPC` → "No space left on device").
 *
 * Key design choice: Node reports `code` and its own libuv message ("ENOSPC: no space left on
 * device, write") but has no strerror. The common disk errors are mapped to glibc's wording, so
 * a client sees the same -MISCONF text as from Redis; anything else falls back to Node's message.
 *
 * Mirrors the strerror(errno) calls in Redis aof.c.
 */

const STRERROR: Readonly<Record<string, string>> = {
  EACCES: 'Permission denied',
  EAGAIN: 'Resource temporarily unavailable',
  EBADF: 'Bad file descriptor',
  EDQUOT: 'Disk quota exceeded',
  EFBIG: 'File too large',
  EINTR: 'Interrupted system call',
  EIO: 'Input/output error',
  EISDIR: 'Is a directory',
  ENOENT: 'No such file or directory',
  ENOSPC: 'No space left on device',
  EPERM: 'Operation not permitted',
  EROFS: 'Read-only file system',
};

export function strerror(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && code in STRERROR) return STRERROR[code]!;
    if (e instanceof Error) return e.message;
  }
  return String(e);
}
