/**
 * Replacing files safely (rule 8): write a temp file → fsync → rename → fsync the directory,
 * and clean up the temp files a crash leaves behind.
 *
 * Key design choice: the rename is the commit point. Until it happens the old file is untouched,
 * so a crash at any moment leaves either the complete old file or the complete new one, never a
 * mix. The fsync before the rename makes the new bytes durable before the name points at them;
 * the directory fsync makes the rename itself durable. Without the second one, a power loss can
 * bring back the old name after the new file was acknowledged.
 *
 * Imported as `fs` (the module object) so tests can make any step fail.
 *
 * Mirrors Redis rdb.c (rdbSave's temp-file-then-rename, rdbRemoveTempFile) and util.c
 * (fsyncFileDir).
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';

/** Names our jobs give their unfinished output (spec 6.2). */
const TEMP_FILE = /^temp-(?:\d+-\d+\.mrdb|rewrite-\d+\.aof)$/;

/** `temp-<pid>-<n>.mrdb` in `dir`: one per snapshot, so a SAVE never shares a BGSAVE's file. */
export const tempSnapshotPath = (dir: string, n: number): string =>
  join(dir, `temp-${process.pid}-${n}.mrdb`);

/** `temp-rewrite-<pid>.aof` in `dir`: there is only ever one rewrite at a time. */
export const tempRewritePath = (dir: string): string =>
  join(dir, `temp-rewrite-${process.pid}.aof`);

/** Writes all of `data` at the file's current position, however many calls it takes. */
export function writeAllSync(fd: number, data: Uint8Array): void {
  let written = 0;
  while (written < data.length) written += fs.writeSync(fd, data, written);
}

/** Makes a rename in `dir` durable. Windows can't open a directory for fsync, and needs none. */
export function fsyncDirSync(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** fsyncDirSync on libuv's thread pool, for jobs that must not block the event loop. */
export function fsyncDir(dir: string, done: (err: Error | null) => void): void {
  if (process.platform === 'win32') {
    done(null);
    return;
  }
  fs.open(dir, 'r', (err, fd) => {
    if (err) {
      done(err);
      return;
    }
    fs.fsync(fd, (syncErr) => fs.close(fd, () => done(syncErr)));
  });
}

/** Deletes a file if it's there; any error is ignored (it's only ever a temp file). */
export function unlinkQuiet(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    // Already gone, or never created.
  }
}

/**
 * Replaces `path` with `chunks` through `tempPath` (rule 8). On any error the temp file is
 * removed, the old file is left as it was, and the error is rethrown.
 */
export function writeFileAtomicSync(
  path: string,
  tempPath: string,
  chunks: readonly Buffer[],
): void {
  const fd = fs.openSync(tempPath, 'w');
  try {
    for (const chunk of chunks) writeAllSync(fd, chunk);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    unlinkQuiet(tempPath);
    throw e;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tempPath, path);
  } catch (e) {
    unlinkQuiet(tempPath);
    throw e;
  }
  fsyncDirSync(dirname(path));
}

/** Startup (spec 9.9 step 1): deletes jobs' unfinished files. Returns the names it removed. */
export function removeLeftoverTemps(dir: string): string[] {
  const removed: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!TEMP_FILE.test(name)) continue;
    unlinkQuiet(join(dir, name));
    removed.push(name);
  }
  return removed;
}
