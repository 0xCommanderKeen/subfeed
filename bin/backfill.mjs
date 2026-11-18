import { setTimeout as sleep } from 'node:timers/promises';
import { BackfillHeld, backfillChannel } from '../src/backfill.mjs';
import { openSeededDb } from '../src/channels-file.mjs';
import { loadEnv } from '../src/env.mjs';
import { BACKFILL_LIMIT, RESERVE_UNITS, dbMeter, fetchApi, quotaPausingApi, unitsToday } from '../src/youtube-api.mjs';

const MISSING_KEY = `YOUTUBE_API_KEY is not set.

bin/backfill.mjs reads full channel history from the YouTube Data API v3, which needs a free API key:
  1. Open https://console.cloud.google.com/ and create (or pick) a project.
  2. APIs & Services > Library: search for "YouTube Data API v3" and click Enable.
  3. APIs & Services > Credentials > Create credentials > API key. Copy the key.
  4. Put YOUTUBE_API_KEY=<your key> in a .env file at the top of the repository (it is gitignored),
     then run: node bin/backfill.mjs [--again] [@handle]

The default quota is 10,000 units a day. A backfill costs about 2 units per 50 videos.
It pauses at ${BACKFILL_LIMIT.toLocaleString('en-US')} units, keeping ${RESERVE_UNITS.toLocaleString('en-US')} for refreshes, and continues after midnight Pacific time.`;

async function main() {
  loadEnv();
  const key = process.env.YOUTUBE_API_KEY || null;
  if (!key) {
    console.error(MISSING_KEY);
    process.exit(1);
  }
  const db = openSeededDb();
  const channels = db.listChannels().filter((c) => c.subscribed);
  const args = process.argv.slice(2);
  const again = args.includes('--again');
  const handleArg = args.find((a) => a !== '--again');
  let targets = channels;
  if (handleArg) {
    const handle = (handleArg.startsWith('@') ? handleArg : `@${handleArg}`).toLowerCase();
    targets = channels.filter((c) => c.handle?.toLowerCase() === handle);
    if (!targets.length) {
      console.error(`No subscribed channel with handle ${handleArg}. Add it first with node bin/add-channel.mjs or the Manage page.`);
      process.exit(1);
    }
  }

  const meter = dbMeter(db, fetchApi(key));
  const api = quotaPausingApi(meter.api, {
    unitsToday: () => unitsToday(db),
    wait: sleep,
    now: db.now,
    onPause: (resumesAt) => console.log(`Paused for quota: continues at ${resumesAt.toLocaleString()} (midnight Pacific time)`),
  });
  let failed = 0;
  let skipped = 0;
  for (const channel of targets) {
    if (!again && db.backfill(channel.id)?.state === 'done') {
      skipped++;
      console.log(`${channel.name}: already backfilled; add --again to read it again`);
      continue;
    }
    const unitsBefore = meter.unitsSinceStart;
    try {
      const r = await backfillChannel(channel, { api, db });
      console.log(`${channel.name}: ${r.long} long, ${r.short} shorts (${meter.unitsSinceStart - unitsBefore} units)`);
    } catch (err) {
      if (err instanceof BackfillHeld) {
        skipped++;
        console.log(`${channel.name}: skipped: the server or another bin/backfill.mjs is backfilling it`);
        continue;
      }
      failed++;
      console.error(`${channel.name}: failed: ${err.message}`);
    }
  }
  db.close();
  console.log(`Done: ${targets.length - failed - skipped}/${targets.length} channels, ${skipped} skipped, ${meter.unitsSinceStart} API units used`);
  if (failed) process.exit(1);
}

await main();
