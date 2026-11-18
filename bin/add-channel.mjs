import { openSeededDb } from '../src/channels-file.mjs';
import { loadEnv } from '../src/env.mjs';
import { fetchChannelFeeds } from '../src/feed.mjs';
import { INPUT_HELP, parseChannelInput } from '../src/resolve.mjs';
import { subscribeChannel } from '../src/subscribe.mjs';
import { dbMeter, fetchApi } from '../src/youtube-api.mjs';

loadEnv();

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [input, ...topicArgs] = process.argv.slice(2);
const topicIds = [...new Set(topicArgs)];
if (!input) fail('Usage: node bin/add-channel.mjs <@handle | channel URL> [topicId...]');
const ref = parseChannelInput(input);
if (!ref) fail(`Not a channel: "${input}". ${INPUT_HELP}`);

const db = openSeededDb();
const known = db.listTopics().map((t) => t.id);
const unknownTopic = topicIds.find((t) => !known.includes(t));
if (unknownTopic) fail(`No topic "${unknownTopic}". Topics: ${known.join(', ') || 'none yet'}. Create one on the Manage page.`);
const key = process.env.YOUTUBE_API_KEY || null;
const meter = key ? dbMeter(db, fetchApi(key)) : null;
let stored = 0;
let feedError = null;
let result;
try {
  result = await subscribeChannel(db, ref, topicIds, {
    api: meter?.api,
    fetchPage: fetch,
    fetchFeeds: async (id) => {
      const feeds = await fetchChannelFeeds(id);
      stored = feeds.videos.length;
      return feeds;
    },
    onChannel: (id, error) => {
      feedError = error ?? null;
    },
  });
} catch (err) {
  fail(`Could not look up ${input}: ${err.message}`);
}
if (!result) fail(`No YouTube channel found for ${input}`);

const { created, channel } = result;
const topics = db.listChannels().find((c) => c.id === channel.id).topics;
console.log(`${created ? 'added' : 'updated'} ${channel.name} (${channel.handle ?? 'no handle'}, ${channel.id}) ${topics.length ? `with topics ${topics.join(', ')}` : 'with no topics'}`);
console.log(feedError ? `RSS feed failed: ${feedError}` : `stored ${stored} videos from RSS`);
if (meter) console.log(`${meter.unitsSinceStart} API unit${meter.unitsSinceStart === 1 ? '' : 's'} used`);
if (created) console.log(`Load older videos with ${channel.handle ? `node bin/backfill.mjs ${channel.handle}` : 'Backfill on the Manage page'}`);
db.close();
