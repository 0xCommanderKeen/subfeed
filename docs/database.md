# Database and refreshes

Where subfeed keeps its data, how it reads the feeds, how it stops, and how to back up and restore the database.

## History and the database

The server stores state in `data/subfeed.db`, a SQLite file that it creates on first start. Set `SUBFEED_DB` to a file path to have the server and the CLI scripts use another database; the server's backups then go to a `backups` folder next to that file. The `data/` folder is gitignored. Delete the file to start over. `PRAGMA user_version` counts the schema migrations the file has run. On start the server runs the missing ones, oldest first, each in its own transaction. Foreign keys tie each video to its channel, each favorite, watched mark and queue entry to its video, and each topic link and rule to its channel and topic. The database refuses a row that points at nothing, and deleting a channel or topic deletes the rows that point at it.

- `channels` holds each channel's id, name, handle, avatar URL, and whether it is subscribed and a favorite. See [Channel avatars](youtube-api.md#channel-avatars).
- `topics` holds each topic's id, display name, position, and whether it is hidden from the sidebar list. `channel_topics` links channels to topics; a channel can have several.
- `videos` holds every video seen, with its channel, title, publish time, thumbnail, view count, duration, whether it is a Short, its kind, whether it may be announced (`announce`, 0 for a video stored by a channel's first fetch, a backfill, or while its channel was not a favorite), when a notification announced it, when its view count was last looked up (`stats_at`), and the words of its title folded for the rules. See [Durations and kinds](youtube-api.md#durations-and-kinds), [Notifications](features.md#notifications), and [Hot](features.md#hot).
- `video_descriptions` holds each video's description, apart from `videos` so that lists read small rows. `videos_fts` is the full-text index of video titles and descriptions. See [Search](features.md#search).
- `favorites` and `watched` hold the ids of starred and watched videos.
- `queue` holds the Watch Later queue: each video's id, when it was added, and its position. See [Watch Later](features.md#watch-later).
- `positions` holds where the player stopped in each video, in whole seconds, and when that was saved. A trigger deletes it with its video. See [The player](features.md#the-player).
- `visits` holds, for each group, when it was last opened. See [New videos and the last visit](features.md#new-videos-and-the-last-visit).
- `api_units` holds the YouTube Data API units used per quota day.
- `backfills` holds each channel's backfill: its state, the next playlist page to read, the units and videos it has counted, its error, and which run holds it. See [Load full history (backfill)](youtube-api.md#load-full-history-backfill).
- `rules` holds the mute and route rules: each rule's kind, words as typed and folded, and the channel and topic it is limited to. See [Rules](features.md#rules).
- `meta` holds whether `channels.json` has been imported.
- `stats_version` holds a counter that triggers raise whenever a channel's video counts could change, so the server keeps those counts in memory until then.

The database is the source of truth for channels and topics. When a new database has no channels yet and `channels.json` exists, the server imports it. After that it ignores the file, so edit channels on the Manage page instead. `channels.json` is your own list, so git ignores it; `channels.example.json` shows the layout. To save the current list to `channels.json`, for example to keep a copy, run:

```sh
node bin/export-channels.mjs
```

The export uses the same one-channel-per-line layout. It writes `"subscribed": false` and `"favorite": true` only for channels that have them, and a `"hiddenTopics"` list of topic ids only when a topic is hidden. A new database seeded from an exported file has the same channels, topics, and flags.

## Refreshes

Each refresh reads three RSS feeds per channel: one for long videos, one for Shorts and one for live streams. Each feed returns the 15 latest entries, so one refresh adds up to 45 videos per channel. A channel without Shorts or streams has no such feed; that counts as none, not as an error. A channel with no public videos at all has none of the three feeds; the server then checks the channel's own feed, and the channel shows as empty rather than failed. Only a channel that YouTube does not know is reported as not found. A feed request that fails or times out (after 10 seconds) is asked once more before its channel counts as failed, and the server logs each refresh's failed channels with their errors. The server refreshes on startup, every 30 minutes, and when you click Refresh. Refreshing the same video again updates its title, views, and thumbnail. It never creates a second row and never clears a known duration.

## Stop the server

On SIGTERM or SIGINT (Ctrl-C) the server stops taking connections, stops the running backfill where it is, so the next start continues it, waits for open requests, closes the database and exits with 0. If that takes over 5 seconds, it exits with 1. So `docker stop` ends the container without waiting for its kill timeout.

## Backups

The server writes a snapshot of the database to `data/backups/subfeed-YYYY-MM-DD.db` once a day, with the channel list next to it as `channels-YYYY-MM-DD.json` in the `bin/export-channels.mjs` layout. Dates are UTC days. The server checks one minute after it starts and then every hour, and writes the snapshot when today's file is missing. So the snapshot appears within an hour after midnight UTC, and a server that was down at that time catches up when it starts.

The snapshot uses SQLite `VACUUM INTO`, so it includes writes that are still in the write-ahead log. A plain copy of `subfeed.db` can miss them.

The server keeps the 7 newest snapshots and, from the older ones, the newest snapshot of each of the 4 most recent ISO weeks. It deletes the others with their channel lists. Retention counts snapshots, not days, so days without a backup never delete the last good ones. Each new snapshot is logged. A failed backup is logged and, when ntfy is set up, sends a high-priority alert titled "subfeed backup failed". See [Notifications](features.md#notifications).

To restore a snapshot:

1. Stop the server. In Docker, run `docker compose stop` in the folder of its `compose.yaml`.
2. Delete `data/subfeed.db-wal` and `data/subfeed.db-shm` if they exist, then copy the snapshot over the database:

   ```sh
   rm -f data/subfeed.db-wal data/subfeed.db-shm
   cp data/backups/subfeed-2026-11-15.db data/subfeed.db
   ```

3. Start the server again.

Delete the `-wal` and `-shm` files first. They belong to the old database, and SQLite would apply them to the restored file.
