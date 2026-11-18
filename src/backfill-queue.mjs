import { randomUUID } from 'node:crypto';
import { BACKFILL_STALE_MS, BackfillHeld, backfillChannel } from './backfill.mjs';
import { isoBefore } from '../public/groups.js';
import { quotaPausingApi, unitsToday } from './youtube-api.mjs';

// Every run of the server names its backfills with this prefix, so a new server takes over the rows the last one held.
const SERVER_OWNER = 'server ';

// The server's backfills, one at a time in the order they were queued, so a large import spreads its quota use. The
// queue and each backfill's progress live in the `backfills` table, so a restart queues them again and each continues
// from the page it reached. Only the running job is in memory: the AbortController that cancels it at its next API
// call or while it waits, and pausedUntil while it waits for the quota to reset. Without a meter nothing runs.
export function backfillQueue({ db, apiMeter, wait }) {
  const { now } = db;
  let current = null;
  let draining = false;
  let stopped = false;
  const staleBefore = () => isoBefore(now(), BACKFILL_STALE_MS);

  function start(channel) {
    if (apiMeter && !stopped && db.queueBackfill(channel.id, { now: now().toISOString(), staleBefore: staleBefore() })) drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (let channel; !stopped && (channel = db.nextQueuedBackfill()); ) await run(channel);
    } finally {
      draining = false;
    }
  }

  // Resolves when the backfill finishes or is cancelled, whichever comes first. A backfill paused for quota holds the
  // queue until it resumes. One that bin/backfill.mjs holds is left to it.
  function run(channel) {
    const controller = new AbortController();
    const { signal } = controller;
    const job = { channelId: channel.id, controller };
    current = job;
    const metered = async (endpoint, params) => {
      signal.throwIfAborted();
      const body = await apiMeter.api(endpoint, params);
      signal.throwIfAborted();
      return body;
    };
    const api = quotaPausingApi(metered, {
      unitsToday: () => unitsToday(db),
      wait: (ms) => wait(ms, signal),
      now,
      onPause: (resumesAt) => {
        job.pausedUntil = resumesAt.toISOString();
        console.log(`backfill of ${channel.name} paused for quota until ${job.pausedUntil}`);
      },
      onResume: () => delete job.pausedUntil,
    });
    // A failure is in the channel's row.
    const finished = backfillChannel(channel, { api, db, owner: SERVER_OWNER + randomUUID(), signal }).catch((err) => {
      if (err instanceof BackfillHeld) console.log(`backfill of ${channel.name} left to the run that holds it`);
    });
    const cancelled = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return Promise.race([finished, cancelled]).finally(() => {
      if (current === job) current = null;
    });
  }

  function cancel(channelId) {
    if (current?.channelId === channelId) current.controller.abort();
    db.deleteBackfill(channelId);
  }

  // For shutdown. Unlike cancel, it keeps the rows: the next server queues them again and each continues from its page.
  function stop() {
    stopped = true;
    current?.controller.abort();
  }

  // { state: 'idle' | 'queued' | 'running' | 'done' | 'error', detail: null | { units, long, short, startedAt?,
  // finishedAt?, error?, pausedUntil? } }. A channel that bin/backfill.mjs is backfilling shows as running too. One whose
  // run died shows as failed, so Backfill is offered and continues it.
  function status(channelId) {
    const row = db.backfill(channelId);
    if (!row) return { state: 'idle', detail: null };
    const died = row.state === 'running' && row.heartbeatAt < staleBefore();
    const { units, long, short, startedAt, finishedAt } = row;
    const state = died ? 'error' : row.state;
    const error = died ? 'the backfill stopped without finishing' : row.error;
    const detail = Object.fromEntries(Object.entries({ units, long, short, startedAt, finishedAt, error }).filter(([, v]) => v !== null));
    if (current?.channelId === channelId && current.pausedUntil) detail.pausedUntil = current.pausedUntil;
    return { state, detail };
  }

  // A backfill paused for quota stores nothing until it resumes, so its channel's new uploads are still announced.
  const storingChannelIds = () => (current && !current.pausedUntil ? [current.channelId] : []);

  if (apiMeter) {
    db.requeueBackfills({ ownerPrefix: SERVER_OWNER, staleBefore: staleBefore() });
    drain();
  }
  return { start, cancel, stop, status, storingChannelIds };
}
