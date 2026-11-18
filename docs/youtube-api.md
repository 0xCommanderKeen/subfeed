# YouTube Data API

What subfeed does with a YouTube Data API key: video lengths and kinds, channel pictures, and the full upload history of each channel.

## Load full history (backfill)

RSS only reaches the latest uploads. To load older videos, `bin/backfill.mjs` reads each channel's complete uploads lists from the YouTube Data API v3. It also fills in each video's duration.

1. Create an API key. In the [Google Cloud console](https://console.cloud.google.com/), create or pick a project. Under APIs & Services > Library, enable "YouTube Data API v3". Under APIs & Services > Credentials, create an API key.
2. Put the key in a `.env` file at the top of the repository. The file is gitignored.

   ```sh
   YOUTUBE_API_KEY=your-key
   ```

3. Run the backfill for every subscribed channel, or for one handle:

   ```sh
   node bin/backfill.mjs
   node bin/backfill.mjs @examplechannel
   ```

   The script skips a channel whose backfill is already done. Add `--again` to read it again, for example `node bin/backfill.mjs --again @examplechannel`.

The script prints the number of long videos and Shorts stored per channel, and the API quota units used. Each call costs 1 unit and covers 50 videos, so a backfill costs about 2 units per 50 videos. A video that already has a duration is not looked up again, so a second backfill of a stored channel costs about 1 unit per 50 videos. The free quota is 10,000 units a day.

Backfills keep 1,000 units of each day for refreshes. When the units used today reach 9,000, or YouTube answers `quotaExceeded`, a backfill pauses and continues where it stopped one minute after midnight Pacific time, when the quota resets. `bin/backfill.mjs` prints the time it continues and waits. The server shows a paused backfill on the Manage page, in the channel row and in the summary at the top, with the time it continues. Unsubscribing or deleting the channel cancels a paused backfill.

Each backfill keeps its progress in the `backfills` table, and stores the place of the next page with each page's videos. A backfill that fails, or that a restart stops, continues from the page it reached: run `bin/backfill.mjs` again, or click Backfill. On start the server queues again the backfills that were queued or running, so a restart does not lose them.

Running the backfill again is safe: it updates rows in place. You can run it while the server is running. A channel is backfilled by one run at a time. `bin/backfill.mjs` skips a channel the server is backfilling, and the server leaves one to `bin/backfill.mjs`. A run that stops without finishing, for example when it is killed, holds its channel for 5 more minutes. After that the Manage page shows its backfill as failed, and Backfill continues it.

The server reads the same `.env`. With a key, adding a channel on the Manage page starts that channel's backfill in the background, and each channel row has a Backfill button. The server runs one backfill at a time. Others wait in a queue, and their rows show "Backfill queued". Unsubscribing or deleting a channel takes it off the queue.

## Durations and kinds

RSS feeds carry no video length. With an API key, each refresh then looks up the videos that have no duration yet with `videos.list`, 50 videos per call, newest first. A refresh makes at most 20 calls, so it fills up to 1,000 videos for 20 units. Older gaps are filled in later refreshes. Without a key, those videos keep an unknown duration.

The same call stores each video's kind:

| Kind | Meaning |
| --- | --- |
| `video` | A regular upload. |
| `short` | A video from the channel's Shorts list. |
| `upcoming` | A scheduled live stream or premiere. |
| `live` | A stream that is live now. |
| `stream_replay` | A stream or premiere that has ended. |
| `unavailable` | The API did not return the video, for example because it is private or deleted. |

Upcoming and live videos have no length yet, so each refresh looks them up again until they end. An unavailable video published in the last 7 days is looked up again, because YouTube can leave out a video that is still processing or briefly private. Older unavailable videos are not looked up again. An API answer without a list of videos fails the lookup, so those videos stay unfilled and the next refresh tries again. Backfill stores the kind too.

Upcoming and live videos count as streams, which **Hide streams** leaves out. See [Groups and views](features.md#groups-and-views). Once a stream or premiere has ended, it counts as a regular video: the API does not tell an aired premiere from a stream replay, so hiding replays would hide aired premieres for good. A Short counts as a Short whatever its kind. A video whose kind is not known yet counts as a regular video.

Every API call costs 1 unit. The server counts the units of every call it makes, and `bin/backfill.mjs` counts its calls too. Both add them to `api_units` per Pacific day, because the quota resets at midnight Pacific time. `GET /api/meta` reports `apiUnits: { lastRefresh, today }`: the units the last refresh used, and the total for the current quota day.

If the quota runs out anyway, for example because another program uses the same key, a refresh logs the failed duration lookup and keeps the videos it already filled. The next refresh after midnight Pacific fills the rest.

## Channel avatars

Channels show their YouTube picture in the shelves, the channel chips, the channel page, and the Manage list. A channel without a picture, or whose picture fails to load, shows a two-letter monogram instead.

Adding a channel stores its picture: from `channels.list` with an API key, otherwise from the channel page. A channel without a stored picture gets one during refreshes, a few per refresh. With an API key, each refresh looks up 50 channels in one `channels.list` call, for 1 unit. Without a key, each refresh reads 10 channel pages. A channel that YouTube no longer has, or that has no picture, is not looked up again. A lookup that fails is tried again in a later refresh.
