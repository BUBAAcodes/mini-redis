/**
 * scheduleBeforeSleep() and beforeSleep() (spec 9.1, steps 4 and 5): the work done once at the
 * end of each event-loop turn, after every socket that was readable has been read.
 *
 * Key design choice: anything that queues a reply or a propagation record calls
 * scheduleBeforeSleep(), which arms at most one setImmediate per turn. setImmediate runs in
 * Node's check phase, right after the poll phase that delivered this turn's socket data, so
 * one beforeSleep sees every command of the turn: the AOF is written once before any reply
 * (rule 8), and each client gets one write however many commands it pipelined.
 * See docs/adr/0003-before-sleep-set-immediate.md.
 *
 * Mirrors Redis server.c (beforeSleep) and networking.c (handleClientsWithPendingWrites).
 */
import type { Client } from './client.js';

/** What beforeSleep runs, in this order (spec 9.1 step 5), before the client replies. */
export interface BeforeSleepHooks {
  /** The input of clients unblocked this turn, so their replies join this flush. */
  beforeWrites?: () => void;
  /** `REPLCONF GETACK *` into the stream if a WAIT blocked this turn. */
  requestAcks?: () => void;
  /** The turn's AOF buffer to the OS (and its fsync under `always`). */
  writeAof?: () => void;
  /** The turn's stream bytes, and anything else queued, to the replicas. */
  writeReplicas?: () => void;
}

export class EventLoop {
  private scheduled = false;
  private readonly pendingWrites = new Set<Client>();

  constructor(private readonly hooks: BeforeSleepHooks = {}) {}

  scheduleBeforeSleep(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this.beforeSleep());
  }

  /** Marks a client as having output (or a close) waiting, and schedules the flush. */
  queueClient(client: Client): void {
    this.pendingWrites.add(client);
    this.scheduleBeforeSleep();
  }

  /** Forgets a client that's gone, so a flush never writes to a dead socket. */
  forget(client: Client): void {
    this.pendingWrites.delete(client);
  }

  /** Also called directly at shutdown to flush what's queued. */
  beforeSleep(): void {
    this.scheduled = false;
    const hooks = this.hooks;
    // Unblocked clients' pipelined input first (Redis's processUnblockedClients): it can queue
    // replies and propagation records, which the steps below then write.
    hooks.beforeWrites?.();
    // Then REPLCONF GETACK for WAIT, the AOF write and fsync, the replication stream; replies
    // only after the AOF (rule 8).
    hooks.requestAcks?.();
    hooks.writeAof?.();
    hooks.writeReplicas?.();
    for (const client of this.pendingWrites) writeClient(client);
    this.pendingWrites.clear();
    // Output buffer limits (step 22) are enforced here.
  }
}

function writeClient(client: Client): void {
  const socket = client.socket;
  if (client.closed || socket === null) return;
  if (client.reply.pendingBytes > 0) {
    // One string per client, one write: cork/uncork keeps it one writev once later steps
    // write big bulks as separate buffers.
    socket.cork();
    socket.write(Buffer.from(client.reply.take(), 'latin1'));
    socket.uncork();
  }
  if (client.closeAfterReply) {
    client.closed = true;
    // Close only once the replies have reached the kernel; destroy() so a peer that never
    // closes its side can't keep the socket half-open.
    socket.end(() => socket.destroy());
  }
}
