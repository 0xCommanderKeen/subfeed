import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportChannels } from './channels-file.mjs';
import { quickCheck } from './db.mjs';

const SNAPSHOT = /^subfeed-(\d{4}-\d{2}-\d{2})\.db$/;
const PARTIAL = /^subfeed-\d{4}-\d{2}-\d{2}\.db\.partial$/;
const KEEP_DAILY = 7;
const KEEP_WEEKLY = 4;

// Snapshot dates are UTC days, so names do not depend on the container's time zone.
const backupDay = (now) => now.toISOString().slice(0, 10);
const snapshotName = (day) => `subfeed-${day}.db`;
const channelsName = (day) => `channels-${day}.json`;

// An ISO-8601 week belongs to the year of its Thursday.
export function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / 86_400_000 / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Retention counts snapshots, not calendar days, so a run of failed backups never ages out the last good ones.
export function daysToKeep(days, { daily = KEEP_DAILY, weekly = KEEP_WEEKLY } = {}) {
  const newestFirst = [...new Set(days)].sort().reverse();
  const keep = new Set(newestFirst.slice(0, daily));
  const weeks = new Set();
  for (const day of newestFirst.slice(daily)) {
    const week = isoWeek(day);
    if (weeks.has(week)) continue;
    if (weeks.size === weekly) break;
    weeks.add(week);
    keep.add(day);
  }
  return keep;
}

const listDays = (dir) => readdirSync(dir).map((f) => f.match(SNAPSHOT)?.[1]).filter(Boolean);

export function runBackup(db, { now = db.now(), dir }) {
  mkdirSync(dir, { recursive: true });
  // VACUUM INTO refuses an existing file, and a half-written snapshot must never pass for a finished one.
  for (const f of readdirSync(dir).filter((f) => PARTIAL.test(f))) rmSync(join(dir, f), { force: true });
  const day = backupDay(now);
  const target = join(dir, snapshotName(day));
  let created = false;
  if (!existsSync(target)) {
    const partial = `${target}.partial`;
    try {
      db.snapshot(partial);
      const check = quickCheck(partial);
      if (check !== 'ok') throw new Error(`snapshot failed quick_check: ${check}`);
      renameSync(partial, target);
    } catch (err) {
      rmSync(partial, { force: true });
      throw err;
    }
    writeFileSync(join(dir, channelsName(day)), exportChannels(db));
    created = true;
  }
  const days = listDays(dir);
  const keep = daysToKeep(days);
  const removed = days.filter((d) => !keep.has(d));
  for (const d of removed) {
    rmSync(join(dir, snapshotName(d)), { force: true });
    rmSync(join(dir, channelsName(d)), { force: true });
  }
  return { day, file: target, created, removed };
}

// Checks every hour and once shortly after start, so today's snapshot appears soon after midnight UTC
// and a server that was down at that time catches up.
export function scheduleBackups(db, { onFailure, dir, firstDelayMs = 60_000, everyMs = 60 * 60_000 }) {
  const check = () => {
    try {
      const r = runBackup(db, { dir });
      if (r.created) console.log(`backup: wrote ${r.file}${r.removed.length ? `, removed ${r.removed.join(', ')}` : ''}`);
    } catch (err) {
      console.error(`backup failed: ${err.message}`);
      Promise.resolve(onFailure(err)).catch((e) => console.error(`backup failure alert failed: ${e.message}`));
    }
  };
  const first = setTimeout(check, firstDelayMs);
  const timer = setInterval(check, everyMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// openDb gathers planner statistics at startup; this keeps them current as the tables grow.
// bin/backfill.mjs or bin/add-channel.mjs can hold the lock past busy_timeout; that run is skipped, not fatal.
export function scheduleOptimize(db, { everyMs = 60 * 60_000 } = {}) {
  const timer = setInterval(() => {
    try {
      db.optimize();
    } catch (err) {
      console.error(`optimize failed: ${err.message}`);
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
