/**
 * The WATCH registry (spec 9.10): which clients watch which keys, and the hooks that mark a
 * client's transaction dirty (`dirtyCas`) when one of its watched keys changes.
 *
 * Key design choice: the registry is indexed both ways. Each Db maps key → (client → entry) so a
 * change finds its watchers in O(watchers), and each client lists its entries so UNWATCH, EXEC
 * and disconnects find them in O(watched keys). The inner map is spec 6.1's `Set<Client>` with the
 * client's entry attached, because the entry carries a flag the hooks need: `expired`, set when
 * the key was already logically expired at WATCH time. Deleting such a key (lazily, actively or
 * by a flush) changes nothing a client could have seen, so it clears the flag instead of making
 * EXEC fail; bringing the key back is a change. A client marked dirty is unwatched at once:
 * EXEC will fail anyway, so there's nothing left to track.
 *
 * Mirrors Redis multi.c (watchForKey, unwatchAllKeys, isWatchedKeyExpired, touchWatchedKey,
 * touchAllWatchedKeysInDb).
 */
import type { Client } from '../server/client.js';
import type { Db } from './database.js';

export interface WatchedKey {
  readonly db: Db;
  readonly key: string;
  /** The key was logically expired when WATCH ran (Redis 7's watchedKey.expired). */
  expired: boolean;
}

/** WATCH for one key; watching a key twice is one registration. */
export function watchKey(client: Client, db: Db, key: string): void {
  let watchers = db.watched.get(key);
  if (watchers?.has(client)) return;
  if (watchers === undefined) {
    watchers = new Map();
    db.watched.set(key, watchers);
  }
  // No lookup: WATCH must not delete an expired key (that would itself be a change to propagate).
  const entry: WatchedKey = { db, key, expired: db.isExpired(key) };
  watchers.set(client, entry);
  client.watchedKeys.push(entry);
}

export function unwatchAllKeys(client: Client): void {
  for (const { db, key } of client.watchedKeys) {
    const watchers = db.watched.get(key);
    if (watchers === undefined) continue;
    watchers.delete(client);
    if (watchers.size === 0) db.watched.delete(key);
  }
  client.watchedKeys = [];
}

/**
 * At EXEC: has a watched key passed its deadline since WATCH? It may still be stored (nobody
 * touched it), but a client reading it now would find it gone, so it counts as changed.
 */
export function isWatchedKeyExpired(client: Client): boolean {
  for (const wk of client.watchedKeys) {
    if (!wk.expired && wk.db.isExpired(wk.key)) return true;
  }
  return false;
}

/** After a key changed or was deleted: every watcher's EXEC must fail. */
export function touchWatchedKey(db: Db, key: string): void {
  const watchers = db.watched.get(key);
  if (watchers === undefined) return;
  for (const [client, wk] of watchers) {
    // Dead at WATCH time and now gone: logically nothing changed. Present again: a change.
    if (wk.expired && !db.hasEntry(key)) {
      wk.expired = false;
      continue;
    }
    markDirty(client);
  }
}

/** Before a db is emptied: only watched keys that are actually stored count as changed. */
export function touchAllWatchedKeysInDb(db: Db): void {
  for (const [key, watchers] of db.watched) {
    if (!db.hasEntry(key)) continue;
    for (const [client, wk] of watchers) {
      if (wk.expired) {
        wk.expired = false;
        continue;
      }
      markDirty(client);
    }
  }
}

function markDirty(client: Client): void {
  client.dirtyCas = true;
  // Deleting from the maps being iterated by the callers is safe: JS Map iteration allows it.
  unwatchAllKeys(client);
}
