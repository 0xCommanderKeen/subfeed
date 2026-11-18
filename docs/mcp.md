# MCP

The server answers MCP at `/mcp`, so Claude can browse the subscriptions. To add it to Claude Code:

```sh
claude mcp add --transport http subfeed http://localhost:4173/mcp
```

For a server on another machine, use its address instead, and list that host in `ALLOWED_HOSTS` (see [Request checks](api.md#request-checks)).

These tools only read:

- `list_groups` lists the sidebar groups with their channel and video counts and how many videos are new since the last visit.
- `new_videos` lists a group's videos since a date or a span such as `24h`, `7d` or `2w`, at most 10 years back. By default it starts at the group's last visit, like the NEW badge. It does not move the last visit.
- `search` searches video titles and descriptions in a group, as described in [Search](features.md#search).
- `channel_videos` lists a channel's newest videos.
- `watch_later_queue` lists the Watch Later queue in queue order, next video first.

These tools change data. Their descriptions start with "Changes subfeed":

- `favorite_video` stars or unstars a video.
- `watch_later` adds a video to the end of the Watch Later queue, or takes it off. A video already in the queue keeps its place.
- `favorite_channel` makes a channel a favorite or removes it.
- `add_channel` adds a channel to existing topics, as on the Manage page. It never creates a topic.

`favorite_video` and `watch_later` end the video line with its new state, such as `starred`, `in Watch Later (3rd)` or `not in Watch Later`. The place in Watch Later counts the videos that `watch_later_queue` lists, so it leaves out Shorts unless the video is a Short. `favorite_channel` says whether the channel is now a favorite.

`new_videos` shows at most 50 videos and `search` at most 30. A longer answer ends with how many are left and the offset that fetches them, such as `… and 33 more. Call again with offset: 30.` A search with more than 10,000 matches says "More than 10000" and ends with `… and more.` instead.

Each video is one line: title, channel, age, length, and URL. The tools leave out Shorts unless asked to include them. A group can be named by its id, its topic id, or its name. A channel can be named by its id, its handle, or its name.

The server checks each call's arguments against the tool's input schema before the tool runs. A missing, unknown or wrong argument returns an error result that names it, such as `video is required` or `unknown argument limit; new_videos takes group, since, include_shorts, offset`.

The endpoint is stateless and answers JSON, not event streams. Like the rest of the app, it has no sign-in, and it follows the same [request checks](api.md#request-checks). See [Security](../README.md#security).
