# Working on subfeed

A short guide for agents and developers. Setup, configuration and deployment live in [README.md](README.md), and the feature, database, HTTP API and MCP docs in `docs/`. Link to them; do not copy them here.

## What it is

A local YouTube feed server on Node 26 with zero dependencies. SQLite comes from `node:sqlite`.

## Commands

- `npm test` is the only check. It runs `node --test test/` in about 6 seconds with no network.
- `npm start` runs `src/server.mjs`. `PORT` (default 4173) and `HOST` (default `127.0.0.1`) set where it listens. See [Configuration](README.md#configuration).
- `openDb(':memory:')` from `src/db.mjs` gives a scratch database for experiments and tests. `openDb(file, { now })` stamps rows and measures time windows with the clock `now` and exposes it as `db.now`. `createApp`, the backfills and the API meter read the time from `db.now`, so a test with a fixed time passes `now` to `openDb` only.

## Layout

- `src/` holds the server and every module it uses. `bin/` holds the command-line scripts: `bin/add-channel.mjs`, `bin/export-channels.mjs`, `bin/backfill.mjs` and `bin/make-icons.mjs`. The backfill itself is in `src/backfill.mjs`, which the server also runs. Code in both folders finds `data/`, `.env`, `channels.json` and `public/` at the top of the repository.
- `src/server.mjs` holds `createApp` and its `ROUTES` table, the HTTP handlers, and `main()`.
- `src/schema.mjs` holds the tables, indexes and triggers in the ordered `MIGRATIONS`. `src/db.mjs` opens the database and combines the query modules in `src/db/`. They hold every query, and no other file writes SQL:
  - `src/db/filters.mjs` holds the shared filter SQL, `hiddenSql` and `toVideo`.
  - `src/db/videos.mjs` stores videos and their details, view counts and notifications. `src/db/backfills.mjs` holds the backfill progress.
  - `src/db/listing.mjs` holds the feed pages, search, Hot and shelves. `src/db/stats.mjs` holds the sidebar tallies, `channelStats()`.
  - `src/db/library.mjs` holds favorites, Watch Later, watched marks, visits, channels, topics and rules.
  - Each module is a factory that takes the connection, `tx` if it writes in a transaction, and `stamp` if it reads the time, and returns its methods. No query module reads the real clock. A method calls another of its module directly, not through `this`.
- `src/mcp.mjs` is the MCP transport (JSON-RPC over `POST /mcp`). `src/mcp-tools.mjs` defines the tools.
- `src/request.mjs` holds `parseRequest()`, which checks a route's path, query and body, and the field types it checks them with.
- `src/http-guard.mjs` holds `refusal()`, the host and content-type check. `src/error-boundary.mjs` wraps the handler.
- `public/*.js` is browser code. `public/vocab.js` (id patterns, title words), `public/groups.js` and `public/kinds.js` are also imported by the server, so they must not use the DOM.
- `test/*.test.mjs` are the tests; `test/fixtures` holds saved YouTube pages and API answers.

## Rules

- No dependencies. Do not add anything to `package.json` `dependencies`.
- The database is the source of truth for channels and topics. `channels.json` only seeds a new database. It is the user's own list and gitignored; `channels.example.json` shows the layout. See [History and the database](docs/database.md#history-and-the-database).
- Every request passes `refusal()` before any handler runs. Do not add a path around it. See [Request checks](docs/api.md#request-checks).
- Validate ids before they reach the database: `VIDEO_ID` and `CHANNEL_ID` from `public/vocab.js`, or a route's declared `params`.
- HTTP handlers report bad input with `throw new HttpError(status, message)`. The client gets `{ "error": message }`.
- MCP tools report failures with `throw new Error(message)`. `src/mcp.mjs` returns it as a result with `isError: true` so the model reads it. `RpcError` is only for protocol faults.

## Protected paths

Put a schema change in its own small PR, apart from the feature that uses it, and expect a PR that touches a path in the `protect` list of `.factory.json` to wait for a maintainer's review.

## Changing the schema

1. Append a function to `MIGRATIONS` in `src/schema.mjs`. It runs inside its own transaction and may run any SQL: `ALTER TABLE`, a table rebuild with `rebuildTable`, or a one-time data fix. `openDb` runs it once on every database, new or old, and `user_version` counts the migrations run.
2. Never edit a migration that has shipped. That includes `TABLES` and the index and trigger SQL of migration 1. A database that ran it does not run it again. The test "a database from an older commit or from migration 1 ends with the same schema and user_version as a new one, and keeps its rows" in `test/db.test.mjs` fails when they differ.
3. If `channelStats()` reads a new column, add or replace a `stats_*` trigger that raises `stats_version` when the column changes. Otherwise the cached counts go stale.
4. A change to the fold in `public/vocab.js` needs a migration that sets `videos.title_words` and `rules.words` again.
5. Test the migration on a database that has rows from before it.
6. Update the table's line in [History and the database](docs/database.md#history-and-the-database).

`src/schema.mjs` is protected, so a schema change is its own PR. Query changes in `src/db.mjs` and `src/db/` are not.

## Adding a route

1. Add an entry to `ROUTES` in `createApp` in `src/server.mjs`: `{ method, path: '/api/x/:id', params, query, body, handler }`. `params`, `query` and `body` map each name to a field type from `src/request.mjs` or `src/server.mjs`, such as `videoId`, `int(1, 50)`, `oneOf([...])`, `arrayOf(knownTopic, ...)` or `optional(bool)`. `parseRequest()` refuses anything else with 400. A `known(...)` path id that names nothing answers 404.
2. The handler gets one object of checked values and never sees `req`. A handler that returns `undefined` answers 204; any other value is sent as JSON. Throw `HttpError(404, ...)` for a missing thing.
3. Add a row to the [Routes](docs/api.md#routes) table. A test fails for a route without one.
4. Add a test in `test/server.test.mjs` (or the feature's test file). `startApp(t)` from `test/helpers.mjs` runs `createApp` on a real port over `openDb(':memory:')` and closes it after the test.

## Adding an MCP tool

1. Add an entry to the array in `subfeedTools()` in `src/mcp-tools.mjs`: `name`, `title`, `description`, `inputSchema: object({...}, required)`, `annotations`, and `run(args)`.
2. Use `annotations: READ` for a tool that only reads. Use `WRITE` for one that changes data, and start its description with "Changes subfeed".
3. Return plain text. Write each video with `line(v)`, which is `videoLine` at the injected clock `now`.
4. Throw `Error` with a message the model can act on, for example a list of valid names.
5. Add a test that calls it over `/mcp` with `mcp(name, args)` from `startApp`, like "the MCP tools read and change the same videos as the HTTP API" in `test/server.test.mjs`. Unit tests of its helpers go in `test/mcp-tools.test.mjs`.
6. Add a line to the read or change list in [MCP](docs/mcp.md).

## Tests

- `node:test` and `node:assert/strict` only.
- Name each test as a sentence that states the behavior, such as "a body over 1 MiB is refused with 413 by the API and by /mcp".
- No network. `startApp` and `testApp` in `test/helpers.mjs` fake `fetchFeeds` and `fetchPage`; pass fakes for `api` and `notify` when a test needs them. Saved pages and API answers go in `test/fixtures`.
- A change that users, the API or the MCP tools can see updates its doc in the same PR: the feature's section in `docs/`, [Routes](docs/api.md#routes), [MCP](docs/mcp.md), or [Configuration](README.md#configuration) for a new environment variable.
