# HTTP API

The routes the web pages use, and the checks every request passes.

## Routes

| Method and path | Purpose |
| --- | --- |
| `GET /api/meta` | Topics in order, each with its id, name and whether it is hidden, subscribed channels with video counts and backfill state, starred and queued video counts and latest upload times, the last visit per group, the rules, API units used, and `youtubeSubscriptions`: `{ newChannels, checkedAt, error }`, or null when [From YouTube](features.md#from-youtube) is off. |
| `GET /api/videos?topic=&channel=&favoriteChannels=1&favorites=1&queued=1&shorts=&streams=&watched=&muted=&length=&sort=&q=&limit=&before=` | One page of videos, newest first, or by `sort`. Pass `nextCursor` from a page as `before` to get the next one. |
| `GET /api/shelves?topic=&favoriteChannels=1&favorites=1&queued=1&shorts=&streams=&watched=&muted=&length=&perChannel=12&channels=20&after=` | The newest `perChannel` videos (1 to 50) of each subscribed channel, channels ordered by latest upload, `channels` shelves (1 to 100) per page. Each shelf names its channel by `channelId`; the channel itself is in `/api/meta`. Pass `nextCursor` from a page as `after` to get the next one. |
| `PUT /api/visits/:group` | Body `{ "seenAt": "<ISO time>" }`. `:group` is `all`, `favorite-channels`, or `topic:<id>`. A `seenAt` later than the server's clock is stored as the server's time. |
| `PUT` and `DELETE /api/favorites/:videoId` | Star or unstar a video. |
| `PUT /api/watched/:videoId` | Mark a video as watched. An upcoming video is not marked. |
| `DELETE /api/watched/:videoId` | Mark a video as unwatched. |
| `PUT /api/position/:videoId` | Body `{ "seconds": <whole number> }`, 1 to 604800. Saves where the player stopped in the video, replacing the place saved before. |
| `DELETE /api/position/:videoId` | Forget where the player stopped in the video. |
| `GET /api/queue?shorts=&streams=&order=` | The Watch Later queue. `order` is `queue` (the default) for the order set by adding and moving videos, `newest` for the last added first, or `oldest` for the first added first. |
| `PUT /api/queue/:videoId` | With no body, add the video to the end of the queue. Body `{ "before": "<videoId>" }` moves it in front of that queued video, and `{ "before": null }` moves it to the end. |
| `DELETE /api/queue/:videoId` | Take a video off the queue. |
| `POST /api/share` | Body `{ "url": "<YouTube video link>" }`. Adds the video to the end of the queue and answers `{ queued, video, channel }`. When its channel is not in subfeed, `queued` is `false` and nothing is stored. See [Install on a phone](features.md#install-on-a-phone). |
| `GET /api/channels`, `POST /api/channels`, `PATCH` and `DELETE /api/channels/:id`, `POST /api/channels/:id/backfill` | Used by the Manage page. |
| `POST /api/topics`, `PATCH` and `DELETE /api/topics/:id` | Used by the Manage page. `PATCH` takes `name`, `position` (the new index), and `hidden`. |
| `POST /api/topics/:id/channels` | Body `{ "channels": ["<channelId>", …], "linked": true }` adds the topic to every listed channel; `"linked": false` removes it. Returns `{ changed }`, the number of channels that changed. Used by the Manage page. |
| `GET /api/rules`, `POST /api/rules`, `DELETE /api/rules/:id` | Used by the Manage page. `POST` takes `kind` (`mute` or `route`), `pattern`, and `channel` and `topic`, each an id or null; a route rule needs both. |
| `POST /api/import/preview` | Body `{ "csv": "<text of subscriptions.csv>" }`. The channels not in subfeed yet, with suggested topics and backfill unit estimates. See [Import subscriptions](features.md#import-subscriptions). |
| `POST /api/youtube-subscriptions/preview` | No body. The same answer as `POST /api/import/preview`, for the channels of the last [YouTube subscriptions](features.md#from-youtube) check. Answers 503 when the check is off and 409 before the first check. |
| `POST /api/import` | Body `{ "channels": [{ "id", "name", "handle", "avatar", "topics", "subscribed" }] }`. Adds the channels that are not in subfeed yet, stores their RSS videos, and queues their backfills. `subscribed` is optional and `true` by default. A channel with `"subscribed": false` is stored unsubscribed, with no videos and no backfill. Answers `{ added, ignored, skipped, backfillsQueued }`: `ignored` counts the channels stored unsubscribed, and `skipped` those already in subfeed. |
| `POST /api/refresh` | Refresh every feed now. |
| `POST /mcp` | MCP over Streamable HTTP. See [MCP](mcp.md). |

The `PUT` and `DELETE` routes under `/api/favorites/`, `/api/watched/`, `/api/queue/` and `/api/position/` return 404 for a video that is not in subfeed. Every video the API returns has `position`, the whole seconds where the player stopped in it, or null.

A route answers 400 for a query parameter or body field it does not take, naming it, and a wrong method answers 405 with an `Allow` header. A malformed id in the path, such as a video id that is not 11 characters, answers 400; a well-formed id that names nothing answers 404. Topic and group ids have no fixed form, so any one that names nothing answers 404. A 400 for a bad value names the field, as in `{ "error": "limit must be 1 to 200" }`. An empty query value counts as absent. `favoriteChannels`, `favorites` and `queued` are `1` or absent; any other value is a 400. `limit` (1 to 200, default 60), `perChannel` and `channels` must be whole numbers in their range, or the answer is a 400.

`shorts` is `include`, `exclude`, or `only`. `streams` is `include` (the default) or `exclude`; `exclude` leaves out videos of kind `live` and `upcoming` that are not Shorts. `watched` is `include` (the default) or `exclude`; `exclude` leaves out videos marked watched. `muted` is `hide` (the default) or `show`; `show` also lists the videos that [rules](features.md#rules) hide, each with `muted: true`. The rules of `topic` apply; without it only the mute rules that name no group do. `favorites=1` and `queued=1` ignore the rules.

Each channel in `/api/meta` has `counts`, `latest`, `starred` and `queued`, split into `long`, `short` and `stream`, and `unwatched` with the same four over its unwatched videos. They leave out the videos that the mute rules naming no group hide. `raw` holds the same five over every video, and `inTopic` maps a topic id to the same five in that topic's group, for each topic whose rules can affect the channel. On `/api/shelves`, each channel's `counts` follow `watched`.

`q` limits the videos to those whose title or description matches it, best match first, as described in [Search](features.md#search). It can be up to 200 characters. The first page of a search also has `total`, the number of matching videos on all pages, up to 10,000; when more match, `total` is 10,000 and `totalCapped` is `true`. `/api/shelves` does not take `q`.

`sort` is `newest` (the default) or `hot`. `hot` lists the last 14 days by views per hour, as described in [Hot](features.md#hot). It needs an API key and view counts no more than 12 hours old, and returns `503` without them; `/api/meta` has `hot: true` when it is available. It cannot be combined with `q`. When Hot is available, each video in `/api/videos` also has `viewsPerHour`, null for videos outside the last 14 days, and `flame`.

`length` is `any` (the default), `short` (under 15 minutes), `medium` (15 to 45 minutes, both included), or `long` (over 45 minutes). Videos with an unknown duration appear only with `any`.

## Request checks

The app has no sign-in, so the server checks every request so that other web pages cannot use it through your browser:

- The `Host` header must name an allowed host: `localhost`, `127.0.0.1` or `[::1]` with the server's `PORT`, or a host in `ALLOWED_HOSTS`. This stops DNS rebinding, where a page on another site points its own hostname at this server.
- A request that is not `GET`, `HEAD` or `OPTIONS` must send `Content-Type: application/json`, even with no body. If it sends `Origin`, the host in it must be allowed too. This stops cross-site form and `text/plain` posts.

A refused request gets `403`, or `415` for a wrong `Content-Type`, with `{ "error": "..." }`.

`ALLOWED_HOSTS` is a comma-separated list of hosts as the browser sends them in `Host`: the name alone for the default port, `host:port` otherwise. For example:

```sh
ALLOWED_HOSTS=subfeed.example.ts.net,192.168.1.50:8080
```
