/**
 * Shutdown (spec 9.14): the one routine behind SHUTDOWN, SIGTERM and SIGINT.
 *
 * Key design choice: the part that can fail runs first, synchronously, with the server still
 * fully up: abort the snapshot job, fsync the AOF, and (unless NOSAVE) SAVE when there are save
 * points or SAVE was asked for. If the save fails nothing has been closed, so the server just
 * logs it and stays up, and the caller can tell its client. Only after that does the point of
 * no return start: stop listening, flush replies, close every socket, log the goodbye and exit.
 * Server.close() does the closing and never saves, so tests and this routine share it.
 *
 * Mirrors Redis server.c (prepareForShutdown, finishShutdown, shutdownCommand).
 */
import { saveSnapshot } from '../persistence/snapshot-format.js';
import type { Server } from './server.js';

export interface ShutdownOptions {
  /** Never save, whatever the save points say. */
  nosave?: boolean;
  /** Save even with no save points. */
  save?: boolean;
}

/**
 * Starts shutting `server` down. Returns false, with the server still running, if the final
 * save failed; true once the closing is under way (the caller must not reply: every socket is
 * about to close, and the process exits when they have).
 */
export function shutdownServer(server: Server, options: ShutdownOptions = {}): boolean {
  if (server.isShuttingDown) return true;
  // Step 1: no job may finish into the files we are about to write (the abort deletes its temp).
  server.snapshotJob?.abort('shutdown');
  // Step 2: what the AOF holds is on disk before anything else can go wrong.
  if (server.aof !== null) {
    server.log.notice('Calling fsync() on the AOF file.');
    server.aof.flush();
    server.aof.syncNow();
  }
  // Step 3.
  const wantSave =
    !options.nosave && (options.save === true || server.config.get('save').length > 0);
  if (wantSave) {
    server.log.notice('Saving the final RDB snapshot before exiting.');
    if (!saveSnapshot(server)) {
      server.log.warning("Error trying to save the DB, can't exit.");
      return false;
    }
  }
  // Step 4.
  void server.close().then(
    () => {
      server.log.warning('MiniRedis is now ready to exit, bye bye...');
      server.exit(0);
    },
    (e: unknown) => {
      server.log.warning(`Error during shutdown: ${(e as Error).message}`);
      server.exit(1);
    },
  );
  return true;
}
