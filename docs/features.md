# Features

How to use subfeed: the groups and views, the player, Watch Later, search, rules, managing channels, and notifications.

## Groups and views

The sidebar on the left lists the groups, each with its number of videos:

- **Everything**, at the top, shows every subscribed channel.
- Under Library, **★ Channels** shows the channels you starred, **★ Videos** shows the videos you starred, and **Watch Later** shows your queue. See [Watch Later](#watch-later).
- Under Groups, one group per topic, in the order set on the Manage page.
- **More**, after the topics, folds the topics hidden on the Manage page. It shows only when a topic is hidden. Click it to open or close it; the page remembers the choice. It opens by itself while a hidden topic is shown, and a dot on it means that a hidden topic has new videos.

The active group has an orange bar and a light tile. The group's name is the heading of the page.

To make the sidebar a narrow rail, click Compact at the bottom of the sidebar or press `[`. In the rail, each topic shows a two-letter tile, for example 3D for 3D Printing; hover a tile to see the full name. The page remembers the choice. On a screen narrower than 900 pixels, the sidebar is hidden. Tap the menu button at the top left to open it. Esc, a tap outside it, or picking a group closes it.

Each group has two views. Switch between them with **Shelves | Feed** under the group name. The page remembers the view per group, and the last group you opened.

- **Shelves** shows one row per channel, the channel with the newest upload first. Each row holds the channel's 12 latest videos and ends in a See all tile. Scroll a row sideways, or use the arrows on a wide screen. Quiet channels, with no videos in the current filter, are listed by name at the bottom.
- **Feed** shows the group's videos as one grid, newest first, under the headings Today, Yesterday, This week, Last week, and then one per month. More videos load as you scroll, back to the oldest stored video. With an API key, **Newest | Hot** next to the view switch sorts the Feed. See [Hot](#hot).

Next to the view switch, **Any | <15m | 15–45m | 45m+** filters the videos by length: any length, under 15 minutes, 15 to 45 minutes, or over 45 minutes. The filter applies to Shelves, Feed, channel pages, and search, and the page remembers it. Videos with an unknown duration appear only under Any. The video counts in the sidebar, on the chips, and on See all do not follow the filter.

The row of channel chips under the heading lists the group's channels with their video counts. Click a chip, a channel name, or See all to open the channel page. It shows the channel's whole history by month, loading older months as you scroll, with a star to make the channel a favorite, a link to the channel on YouTube, and an Unsubscribe button. Unsubscribe returns to the group, and a message at the bottom of the page offers Undo for six seconds (it asks first while the channel's backfill runs or waits, since Undo does not restart it); after that, resubscribe on the Manage page. The length filter is next to these. Click the pressed chip, or the back link, to return to the group. The browser back button also works.

On every video card:

- Click anywhere on the card to play the video on the page. See [The player](#the-player). Middle-click, Cmd-click, or Ctrl-click opens it on youtube.com in a new tab instead. The card dims to show it was watched. Watched marks are stored in the database.
- Click the check mark, next to the clock, to mark the video watched without opening it, for example after watching it on the TV. Click it again to mark the video unwatched.
- Click the star to add the video to ★ Videos, or to remove it. The star does not open the video.
- Click the clock, next to the star, to add the video to Watch Later, or to remove it.
- The star, the clock and the check mark show when you point at the card. On a touch screen they are always shown.
- A premiere or stream that has not started yet carries an UPCOMING badge. It cannot play yet, so clicking it opens it on youtube.com in a new tab, and does not mark it watched, and on the Watch Later page it stays in the queue. It has no check mark. When it has aired, a later refresh gives it its length and its new kind, `video` or `stream_replay`, and it can be marked watched like any other video.

Other controls, at the bottom of the sidebar:

- **Hide Shorts** is on by default and is remembered. The video counts in the sidebar follow it.
- **Hide streams** hides streams and premieres that are live now or have not started yet, as described in [Durations and kinds](youtube-api.md#durations-and-kinds). It is off by default and is remembered. Like Hide Shorts, it applies to Shelves, Feed, channel pages, search, Watch Later, and the video counts.
- **Hide watched** hides the videos marked watched. It is off by default and is remembered. It applies to Shelves, Feed, channel pages, search, ★ Videos, and the video counts. Watch Later still lists its watched videos.
- **Show muted** shows the videos that [rules](#rules) hide.
- **Refresh** reads every channel's feeds now instead of waiting for the next 30-minute refresh. It shows the time of the last refresh, and under its name the YouTube Data API units used today. See [Durations and kinds](youtube-api.md#durations-and-kinds).
- **Manage** opens the channel and topic page.

A notice at the top of the page lists any channels whose feed failed to load.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `j` / `k` | Focus the next or previous video card and scroll it into view. With no card focused, start at the first card on screen. |
| `Enter` or `o` | Open the focused video. |
| `w` | Add the focused video to Watch Later, or take it off. |
| `s` | Star or unstar the focused video. |
| `/` | Search. |
| `[` | Compact sidebar. |
| `?` | Show or hide the list of shortcuts. |

On the Watch Later page, `j` and `k` move between the rows of the queue, `Enter` or `o` plays the row's video as a click does, and `w` takes it off the queue. Rows have no star, so `s` does nothing there.

The focused card has an orange ring. Shortcuts are ignored while you type in a field or hold Ctrl, Alt, or Cmd, and while the player fills the page. They work again while the mini player plays.

## The player

A video plays in an overlay over the page, in the YouTube embed from `youtube-nocookie.com`. Shorts play in a portrait frame.

- A click outside the video, the mini player button, or the browser's Back button shrinks the player to a mini player in the bottom corner. The video keeps playing while you scroll, change groups, search and use the shortcuts. On a narrow screen the mini player is a bar along the bottom. Clicking its title or its expand button makes it full size again. Opening another video plays that one instead. Going to the Manage page stops the video.
- Esc or the close button closes the player. The page stays where it was scrolled. Esc works when the page has the keyboard focus; after a click into the video, press Tab first. In the mini player, the close button closes it.
- The video is marked watched when it ends, or once 90% of it has played. A live stream is marked only when it ends.
- The player saves where a video stopped when you pause, close the player, move to another video, or leave the page, and every 15 seconds while it plays. The place is saved on the server, so every device resumes the video there. A video that has played to 90% or to the end starts from the beginning next time, and so do Shorts, live streams, and a video stopped in its first 5 seconds.
- A video with a saved place shows an orange bar along the bottom of its thumbnail, as long as the share of the video played. A watched video shows no bar.
- **Open on YouTube** pauses the player and opens the video on youtube.com in a new tab, at the time the player reached. This marks the video watched.
- A video whose channel does not allow playing it outside YouTube shows a message and an Open on YouTube button instead.

See [Watch Later](#watch-later) for playing through the queue.

## Watch Later

★ Videos keeps the videos you loved. Watch Later is a queue of videos to watch next, and it empties as you watch.

- Click the clock on any video card to add the video to the end of the queue. The Watch Later tab in the sidebar shows how many videos are queued.
- The Watch Later page lists the queue in order, first added first.
- Clicking a video on the page plays it and then the rest of the queue in order. When a video ends, it is marked watched and comes off the queue, and the next one starts. A message at the bottom of the page offers Undo for six seconds, which puts the video back where it was. Opening a video on YouTube from the player, or with middle-click or Cmd-click on the page, also takes it off the queue. The clock on a row takes the video off without opening it, also with Undo.
- Previous and Next in the player move through the queue without taking videos off. Upcoming premieres and streams are skipped; clicking one opens it on youtube.com, and it stays queued. After the last video ends, the player closes.
- The check mark on a row marks the video watched or unwatched. The video stays in the queue.
- To reorder, use the up and down arrows on each row. With a mouse, you can also drag a row.

The queue is stored in the database, so every device sees the same queue. Hide Shorts applies to the page and to the count. Like every list, the queue shows only subscribed channels' videos: unsubscribing hides a channel's queued videos, and resubscribing brings them back. Deleting a channel removes its videos from the queue.

## Search

The search box at the top of the page searches video titles and descriptions. Press `/` to go to it. Results appear while you type, in the Feed layout, best match first, with the number of matches. Matched words in titles are orange.

- The search covers the current group. Click **Search everything** to search every channel.
- Hide Shorts, Hide streams, and the length filter apply to the results.
- Esc or the × button clears the search and goes back to the group.
- The search is part of the page address, `#/<group>/search/<text>`, so the browser back button and links work.

Each word you type must be the start of a word in the title or the description, in any order. For example, `lizard bowl` finds a title such as "Blood Bowl: Lizardmen vs Dwarfs". Case and accents do not matter. There is no search syntax: quotes, `OR`, `-` and `*` are ignored or searched as plain words.

Results are ranked by bm25, which favors videos where the words are rare and the text is short. A word in the title counts ten times as much as one in the description, so a video about Lizardmen ranks above one that mentions them in passing. Among equal matches, the newer video comes first.

Ranking reads every video that matches, so a search costs time in proportion to its matches. On a small home server, with 375,000 videos and a description for each, `lizardmen` and a three-word query took 4 ms, `blood bowl` 25 ms, `patreon` (121,000 matches) 0.3 seconds and `the` about a second. Searches therefore run in a worker thread of their own, one at a time, so a slow one does not hold up the rest of the app. A search that you typed past before its turn came is dropped. The count stops at 10,000, and a larger result shows as "10,000+ matches".

RSS entries carry each video's description, and so do the backfill's playlist pages. A stored video without a description gets one on the next backfill, or when it shows up in a channel's feed again.

The index is an SQLite FTS5 table that triggers keep up to date when videos are added, renamed, or deleted, and when a description changes. When the index is missing, the server builds it on start. For 89,000 videos on a development machine, that took 0.1 seconds without descriptions and 3 seconds with a description for every video.

## New videos and the last visit

Videos published since your last visit to a group carry a NEW badge. On Shelves, each row shows how many of its videos are new, and a dashed LAST VISIT marker separates them from older ones. In Feed and on channel pages, a LAST VISIT rule does the same. An orange dot on a group's tile in the sidebar, or on a channel chip, means it has new videos. On a narrow screen, a dot on the menu button means that some other group has new videos.

The server stores the last visit per group in the `visits` table, so a phone and a laptop that open the same server agree on what is new:

1. When a browser tab first shows a group, it reads the group's stored visit time and uses it as the baseline for NEW. If the group has no visit yet, the baseline is three days ago.
2. The tab then stores the current time as the group's new visit. Other tabs and devices that open the group later see that time.
3. The tab keeps its baseline until you close it, so reloading the page keeps the NEW markers.
4. **Mark all seen** sets the baseline and the stored visit to now, so NEW markers go away on every device.

The stored time only moves forward. If two devices report visits out of order, the later time wins.

★ Videos has no last visit.

## Hot

With an API key, the Feed view has a sort switch: **Newest**, the default, or **Hot**. The page remembers the choice. Hot lists the videos published in the last 14 days, most views per hour since publish first, under the heading Hot · last 14 days. A video younger than an hour counts as an hour old, so a few early views do not put it on top. Upcoming premieres and streams, and videos without a view count, are left out. The filters and Hide switches apply as in Newest. Search results stay newest first.

Hot needs fresh view counts. After the duration lookups, each refresh looks up the view counts of subscribed channels' videos from the last 14 days whose count is more than 6 hours old, with `videos.list?part=statistics`, 50 videos per call. So each count is renewed about four times a day. A refresh makes at most 10 of these calls, 10 units. A duration lookup brings a fresh view count too, so those videos are not looked up again.

Without an API key, view counts are not kept fresh, so the switch is hidden and the Feed is newest first. The switch and the flames are also hidden while any of those view counts is more than 12 hours old, for example when the lookups keep failing because the quota is used up or the key was revoked, or before the first lookups after you add the key. A video published in the last 12 hours that was not looked up yet does not count as stale.

A card whose views per hour are at least 3 times the average of the channel's other videos of the same format (long or Short) in the last 14 days shows a flame with its views per hour, for example `🔥 12K/h`. The channel needs at least 3 other such videos to compare with. The flame shows only when Hot is available, in the lists that come from `/api/videos`: the Feed in both sorts, a channel's page, and search results. Shelves and Watch Later show no flame.

## Rules

Rules hide videos by their title. Add them in the Rules panel on the Manage page: type the words, pick Mute or Route, a channel and a group, and click Add rule.

- **Mute** hides every video whose title holds the words. With Any channel and Every group it hides them everywhere. With a group, for example "Weekly Q&A" in Miniature Painting, it hides them in that group only. With a channel, it hides them in that channel's videos only.
- **Route** names a channel and a group. The channel's videos appear in that group only when the title holds the words of one of its route rules. For example, a gaming channel routed into Miniature Painting for "Paint Table" shows only its Paint Table videos there, and all of its videos in Everything and its other groups.

The words match whole words in a row, in any case and without accents or punctuation: "live" matches "Battle report LIVE!" but not "Delivery". There is no wildcard or regex syntax.

The rules apply to Shelves, Feed, search, and the video counts in the sidebar, on the chips and on the channel page. A channel page opened from a topic's group follows that group's rules. ★ Videos and Watch Later hold videos you picked, so the rules leave them alone.

**Show muted**, at the bottom of the sidebar, lists the videos the rules hide, grey and marked MUTED, and counts them, so a rule that hides too much is easy to spot. It is off by default and is remembered.

Deleting a channel or a topic deletes its rules.

## Manage channels and topics

Open http://localhost:4173/manage.html, or click Manage at the bottom of the sidebar. The Manage page has the same sidebar, so a click on a group goes back to the videos.

- **Add a channel.** Enter `@handle`, `handle`, `https://www.youtube.com/@handle`, or `https://www.youtube.com/channel/UC…`, pick its topics, and click Add channel. The server looks the channel up (1 API unit with a key, otherwise it reads the channel page), stores its latest videos from RSS right away, and starts a backfill if a key is set. The result shows the backfill progress. Adding a channel that is already in the list resubscribes it and adds the picked topics.
- **Topics.** Click Topics on a channel row to tick or untick its topics.
- **Topics for several channels.** Tick the box at the start of each channel row, or type in the filter box and click Select shown to tick every channel the filter shows. Ticks stay when the filter changes, so you can collect channels from several searches. Then pick a topic in the bar above the list and click Add topic or Remove topic. Clear unticks all.
- **Favorite.** Click the star on a row. The ★ Channels group on the main page shows videos from favorite channels.
- **Unsubscribe.** The channel and its videos leave the page, and refreshes and backfills skip it. Its videos stay in the database, so Resubscribe in the Unsubscribed section brings them back at once. A message at the bottom of the page offers Undo for six seconds. Unsubscribing stops the channel's backfill, which Undo does not restart, so the page asks first while one is running or queued.
- **Last upload.** Each row shows how long ago the channel's newest stored video came out.
- **Inactive.** Click Inactive above the list to see only the subscribed channels with no upload in 6 months, the longest silent first. Pick 3 months, 1 year, or 2 years instead in the menu next to it; the page remembers the choice. All goes back to the list by topic.
- **Unsubscribe several.** Tick the box on each channel row, or click Select shown in the Inactive view, then click Unsubscribe in the bar above the list. Undo in the message at the bottom resubscribes them all. Each ticked subscribed channel the list shows is unsubscribed as above. A tick that the filter, the view, or the Inactive period hides is left alone, though Add topic and Remove topic still take it.
- **Delete.** Removes the channel, its videos, and the favorite and watched marks on those videos. The page asks you to confirm first.
- **Topics panel.** Add, rename, reorder, hide, and delete topics. Deleting a topic keeps its channels.
  - To reorder, use the up and down arrows on each row. With a mouse, you can also drag a row. The sidebar lists the topics in this order. The order is stored in the database, so every device sees it.
  - **Hide** moves a topic out of the sidebar list into the More fold. Its channels and videos still appear in Everything and in the other groups. **Show** puts it back in the list.
- **Rules panel.** Add and delete mute and route rules. See [Rules](#rules).

From the command line:

```sh
node bin/add-channel.mjs <@handle or channel URL> [topicId...]
```

For example, `node bin/add-channel.mjs @examplechannel robotics` adds the channel to the `robotics` topic and stores its RSS videos. Each topic id must name an existing topic; create topics on the Manage page. With no topic ids it adds the channel to no topic. Running it for a channel that is already in the list resubscribes it and adds the given topics. It does not backfill: run `node bin/backfill.mjs @handle` or click Backfill on the Manage page.

## Import subscriptions

To add many channels at once, import your YouTube subscriptions:

1. In [Google Takeout](https://takeout.google.com/), export "YouTube and YouTube Music" with only "subscriptions" selected. The export has `subscriptions.csv`, with the columns `Channel Id`, `Channel Url` and `Channel Title`.
2. On the Manage page, under Import subscriptions, choose that file.
3. Review the list. It shows only the channels that are not in subfeed yet, each with suggested topics. Untick the channels you do not want, and click a topic to add or remove it.
4. Click Import.

With an API key, the server looks the channels up with `channels.list`, 50 channels per call (1 unit each), for their name, handle, picture, description and number of videos. Channels that YouTube no longer has are left out. Without a key, the list uses the titles from the file.

Topics are suggested from each channel's title and description:

- With `ANTHROPIC_API_KEY` in `.env`, Claude (`claude-opus-5-5`) picks the topics. It sees each topic's name and a few of its channels. When at least 3 channels fit no topic and share a theme, it can suggest a new topic for them. Click Create to add that topic and tick it on those channels.
- Without the key, or when the Claude request fails, a channel gets each topic that has a word of its name at the start of a word in the title or description. For example, "3D Printing" matches "printer", and "Board Games" matches "game".

Below the list, the page shows the estimated API units for the backfills of the ticked channels: about 2 units per 50 videos, plus 3 per channel. The free quota is 10,000 units a day.

Each imported channel gets its RSS videos right away, and a backfill in the queue when a YouTube API key is set. Backfills run one at a time. See [Load full history (backfill)](youtube-api.md#load-full-history-backfill). Channels that are already in subfeed, subscribed or not, are never imported again, so importing the same file twice adds nothing.

## Install on a phone

subfeed is an installable web app. In Chrome on Android, open subfeed at its https address and choose **Install app** (or **Add to Home screen**) from the menu. The installed app opens full screen, without the browser bar. Installing needs https, so a plain http address on the LAN does not offer it. A reverse proxy with a certificate, such as Tailscale Serve or Caddy, gives one.

A service worker keeps the app shell: the pages, scripts, styles and icons. It asks the network first, so a deploy shows at once, and it answers from its copy only when the network fails. It never keeps API answers. The icons in `public/` are drawn from `favicon.svg` by `node bin/make-icons.mjs`. Run it again after changing the favicon.

Once installed, subfeed is in the Android share sheet, for example in the YouTube app. Share opens `share.html`:

- A channel link or an `@handle` opens Manage with the add form filled in. Pick its topics and click Add channel.
- A video link (`youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/…` or `/live/…`) adds the video to the end of Watch Later. If its channel is unsubscribed, the page offers to add the channel, because Watch Later only shows subscribed channels' videos.
- A video whose channel is not in subfeed is not added yet, because every stored video belongs to a channel. The page shows the video and offers to add its channel. Manage then opens with the channel filled in, and adding it also puts the video in Watch Later.

A video subfeed has not stored yet, for example one older than the RSS feeds reach, is looked up on YouTube: with `videos.list` (1 API unit) when an API key is set, otherwise on its watch page.

## Notifications

The server can push a notification through [ntfy](https://ntfy.sh) when a favorite channel uploads. Set the topic URL, and an access token if the topic needs one, in `.env`:

```sh
NTFY_URL=https://ntfy.example/subfeed
NTFY_TOKEN=tk_your_token
```

Without `NTFY_URL`, notifications are off.

After each refresh of every channel, the server sends one message per new upload: the channel name as the title, the video title as the text, the thumbnail as the attachment, and a click action that opens the video on youtube.com. A video counts as a new upload when a refresh of every channel stored it for the first time, in the last 24 hours, and its channel already had videos before. So these send nothing:

- the first refresh of a new database,
- adding or resubscribing a channel,
- a backfill, and any refresh while that channel's backfill runs. A backfill paused for quota does not count, so new uploads during the pause are announced.
- uploads stored while the channel was not a favorite. Making a channel a favorite announces only the uploads after it.

Shorts are skipped. With an API key, premieres and streams that have not started yet are skipped too. Without a key the server cannot tell them apart, so they are announced. More than 10 new uploads waiting at one refresh send one summary message instead. Each announced video gets `notified_at` set in `videos`, so a restart or a second refresh never sends it again. A message that ntfy refuses is logged and sent again by the next refresh, as is one a restart kept from being sent, until 24 hours after the video was first stored.
