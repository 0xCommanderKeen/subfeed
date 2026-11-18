import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { openSearchDb } from './db.mjs';

if (!isMainThread && workerData?.searchDb) {
  const searchPage = openSearchDb(workerData.searchDb);
  parentPort.on('message', (query) => {
    try {
      parentPort.postMessage({ result: searchPage(query) });
    } catch (err) {
      parentPort.postMessage({ error: err.message });
    }
  });
}

// db.searchPage over the database file `file`, in a worker thread. node:sqlite blocks the thread it runs on, and ranking
// a word that most videos contain takes seconds on a small home server, so a search on the server's thread stalled every other
// request. Searches run one at a time. One whose `signal` aborts while it waits is dropped, so typing a word does not
// leave a search per keystroke queued behind a slow one.
export function searchWorker(file) {
  let worker = null;
  let running = null;
  let closed = false;
  const waiting = [];

  function start() {
    const w = new Worker(new URL(import.meta.url), { workerData: { searchDb: file } });
    w.on('message', ({ result, error }) => {
      const job = running;
      running = null;
      if (error === undefined) job.resolve(result);
      else job.reject(new Error(error));
      next();
    });
    // A worker that died takes its search with it; the next search starts a new one.
    w.on('exit', (code) => {
      worker = null;
      running?.reject(new Error(`search worker exited with code ${code}`));
      running = null;
      next();
    });
    return w;
  }

  function next() {
    if (running || closed) return;
    let job;
    while ((job = waiting.shift()) && job.signal?.aborted) job.reject(job.signal.reason);
    if (!job) return;
    worker ??= start();
    running = job;
    worker.postMessage(job.query);
  }

  return {
    search(query, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        waiting.push({ query, signal, resolve, reject });
        next();
      });
    },
    async close() {
      closed = true;
      for (const job of waiting.splice(0)) job.reject(new Error('search worker closed'));
      await worker?.terminate();
    },
  };
}
