import { kindSql } from '../public/kinds.js';

// The tables as migration 1 leaves them. A later change to a table is a new migration, not an edit here,
// because a database that already ran migration 1 never runs it again.
const TABLES = {
  videos: `CREATE TABLE videos (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    title TEXT,
    published TEXT,
    thumbnail TEXT,
    is_short INTEGER,
    views INTEGER,
    duration_s INTEGER,
    kind TEXT,
    notified_at TEXT,
    stats_at TEXT,
    title_words TEXT,
    first_seen TEXT,
    updated_at TEXT
  )`,
  favorites: 'CREATE TABLE favorites (video_id TEXT PRIMARY KEY, added_at TEXT)',
  watched: 'CREATE TABLE watched (video_id TEXT PRIMARY KEY, watched_at TEXT)',
  queue: 'CREATE TABLE queue (video_id TEXT PRIMARY KEY, added_at TEXT, position INTEGER)',
  topics: 'CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER, hidden INTEGER NOT NULL DEFAULT 0)',
  channels: `CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    name TEXT,
    handle TEXT,
    subscribed INTEGER NOT NULL DEFAULT 1,
    favorite INTEGER NOT NULL DEFAULT 0,
    added_at TEXT,
    avatar TEXT
  )`,
  channel_topics: 'CREATE TABLE channel_topics (channel_id TEXT, topic_id TEXT, PRIMARY KEY (channel_id, topic_id))',
  visits: 'CREATE TABLE visits (group_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL)',
  api_units: 'CREATE TABLE api_units (day TEXT PRIMARY KEY, units INTEGER NOT NULL)',
  rules: `CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('mute', 'route')),
    pattern TEXT NOT NULL,
    words TEXT,
    channel_id TEXT,
    topic_id TEXT,
    CHECK (kind = 'mute' OR (channel_id IS NOT NULL AND topic_id IS NOT NULL))
  )`,
};

// After a backfill almost no video lacks details, so missingDetails reads this small index rather than every video.
// A change to needsDetails in public/kinds.js needs a migration that creates this index again.
//
// stats_version changes whenever channelStats could, from any connection, so its result can be kept until then.
//
// videos_fts is external content: it keeps no second copy of the titles, and the triggers keep it in step with
// `videos`. It is keyed by the implicit rowid of `videos`, so a rebuild of `videos` keeps the rowids. VACUUM INTO keeps
// them today, because `videos` has an index, but SQLite promises that only for an explicit INTEGER PRIMARY KEY.
// A title that does not change leaves the index alone, so a refresh rewriting the same titles costs nothing there.
const INDEXES_AND_TRIGGERS = `
  CREATE INDEX videos_channel_recent ON videos (channel_id, published DESC, id DESC, is_short);
  CREATE INDEX videos_published ON videos (published, id);
  CREATE INDEX videos_missing_details ON videos (published DESC, id DESC)
    WHERE duration_s IS NULL AND ${kindSql('needsDetails', 'kind')};
  CREATE TABLE IF NOT EXISTS stats_version (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
  INSERT INTO stats_version (id, n) VALUES (1, 0) ON CONFLICT DO NOTHING;
  CREATE TRIGGER stats_video_insert AFTER INSERT ON videos BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_video_delete AFTER DELETE ON videos BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_video_update AFTER UPDATE OF channel_id, published, is_short, kind ON videos
    WHEN old.channel_id IS NOT new.channel_id OR old.published IS NOT new.published
      OR old.is_short IS NOT new.is_short OR old.kind IS NOT new.kind
    BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_channel_insert AFTER INSERT ON channels BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_channel_delete AFTER DELETE ON channels BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_favorite_insert AFTER INSERT ON favorites BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_favorite_delete AFTER DELETE ON favorites BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_queue_insert AFTER INSERT ON queue BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_queue_delete AFTER DELETE ON queue BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_watched_insert AFTER INSERT ON watched BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_watched_delete AFTER DELETE ON watched BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_video_title AFTER UPDATE OF title ON videos WHEN old.title IS NOT new.title
    BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_rule_insert AFTER INSERT ON rules BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_rule_delete AFTER DELETE ON rules BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_link_insert AFTER INSERT ON channel_topics BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE TRIGGER stats_link_delete AFTER DELETE ON channel_topics BEGIN UPDATE stats_version SET n = n + 1; END;
  CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(title, content = 'videos', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER videos_fts_insert AFTER INSERT ON videos BEGIN
    INSERT INTO videos_fts (rowid, title) VALUES (new.rowid, new.title);
  END;
  CREATE TRIGGER videos_fts_delete AFTER DELETE ON videos BEGIN
    INSERT INTO videos_fts (videos_fts, rowid, title) VALUES ('delete', old.rowid, old.title);
  END;
  CREATE TRIGGER videos_fts_update AFTER UPDATE OF title ON videos WHEN old.title IS NOT new.title BEGIN
    INSERT INTO videos_fts (videos_fts, rowid, title) VALUES ('delete', old.rowid, old.title);
    INSERT INTO videos_fts (rowid, title) VALUES (new.rowid, new.title);
  END;
  INSERT INTO videos_fts (videos_fts) VALUES ('rebuild');
`;

// Gives `name` the columns and the exact CREATE TABLE text of `sql`, keeping its rows and rowids. A column the old
// table lacks gets its default. Run with no triggers or views left, since the rename would rewrite them.
function rebuildTable(db, name, sql) {
  const have = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
  if (have?.sql === sql) return;
  if (!have) return db.exec(sql);
  const old = `${name}_old`;
  db.exec(`ALTER TABLE ${name} RENAME TO ${old}`);
  db.exec(sql);
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const kept = new Set(columns(old));
  const shared = columns(name).filter((c) => kept.has(c)).join(', ');
  db.exec(`INSERT INTO ${name} (rowid, ${shared}) SELECT rowid, ${shared} FROM ${old}`);
  db.exec(`DROP TABLE ${old}`);
}

// Migration 1 brings a database of any earlier commit, or an empty file, to one schema. Before it, user_version was 1
// once channels.json had been imported, and the schema was set up again on every open.
function unifySchema(db) {
  const wasSeeded = db.prepare('PRAGMA user_version').get().user_version >= 1;
  const objects = db.prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL").all();
  for (const { type, name } of objects) db.exec(`DROP ${type.toUpperCase()} ${name}`);
  for (const [name, sql] of Object.entries(TABLES)) rebuildTable(db, name, sql);
  db.exec('UPDATE videos SET title_words = spaced_words(title) WHERE title_words IS NULL');
  db.exec('UPDATE rules SET words = spaced_words(pattern) WHERE words IS NULL');
  // A database from before migrations may already have the contentless index of migration 2, which refuses 'rebuild'.
  db.exec('DROP TABLE IF EXISTS videos_fts');
  db.exec(INDEXES_AND_TRIGGERS);
  // Deleting every channel later must not import channels.json again.
  db.exec('CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), seeded INTEGER NOT NULL)');
  db.prepare('INSERT INTO meta (id, seeded) VALUES (1, ? OR EXISTS (SELECT 1 FROM channels))').run(wasSeeded ? 1 : 0);
}

// Migration 2 indexes descriptions as well as titles. Descriptions live in their own table: inline they would make each
// `videos` row several times larger, and every list and search reads those rows. The index is contentless, so it keeps
// no second copy of the text, and the triggers keep it in step with both tables. It stays keyed by the implicit rowid of
// `videos`. Text that does not change leaves the index alone, so a refresh rewriting the same titles and descriptions
// costs nothing here. The two-character prefix index makes a search for a word still being typed, such as `pa`, about
// three times faster, for about a third more index. A database from before migrations may already have this index.
function searchDescriptions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_descriptions (video_id TEXT PRIMARY KEY, description TEXT NOT NULL);
    DROP TRIGGER IF EXISTS videos_fts_insert;
    DROP TRIGGER IF EXISTS videos_fts_delete;
    DROP TRIGGER IF EXISTS videos_fts_update;
    DROP TRIGGER IF EXISTS video_descriptions_fts_insert;
    DROP TRIGGER IF EXISTS video_descriptions_fts_update;
    DROP TABLE IF EXISTS videos_fts;
    CREATE VIRTUAL TABLE videos_fts USING fts5(title, description, content = '', contentless_delete = 1, prefix = '2', tokenize = 'unicode61 remove_diacritics 2');
    CREATE TRIGGER videos_fts_insert AFTER INSERT ON videos BEGIN
      INSERT INTO videos_fts (rowid, title, description)
      VALUES (new.rowid, new.title, (SELECT description FROM video_descriptions WHERE video_id = new.id));
    END;
    CREATE TRIGGER videos_fts_delete AFTER DELETE ON videos BEGIN
      DELETE FROM videos_fts WHERE rowid = old.rowid;
      DELETE FROM video_descriptions WHERE video_id = old.id;
    END;
    CREATE TRIGGER videos_fts_update AFTER UPDATE OF title ON videos WHEN old.title IS NOT new.title BEGIN
      DELETE FROM videos_fts WHERE rowid = new.rowid;
      INSERT INTO videos_fts (rowid, title, description)
      VALUES (new.rowid, new.title, (SELECT description FROM video_descriptions WHERE video_id = new.id));
    END;
    CREATE TRIGGER video_descriptions_fts_insert AFTER INSERT ON video_descriptions BEGIN
      DELETE FROM videos_fts WHERE rowid = (SELECT rowid FROM videos WHERE id = new.video_id);
      INSERT INTO videos_fts (rowid, title, description) SELECT rowid, title, new.description FROM videos WHERE id = new.video_id;
    END;
    CREATE TRIGGER video_descriptions_fts_update AFTER UPDATE OF description ON video_descriptions BEGIN
      DELETE FROM videos_fts WHERE rowid = (SELECT rowid FROM videos WHERE id = new.video_id);
      INSERT INTO videos_fts (rowid, title, description) SELECT rowid, title, new.description FROM videos WHERE id = new.video_id;
    END;
    INSERT INTO videos_fts (rowid, title, description)
      SELECT v.rowid, v.title, d.description FROM videos v LEFT JOIN video_descriptions d ON d.video_id = v.id;
  `);
}

// The tables as migration 3 leaves them. `videos` comes first, since a table that references it, rebuilt before it,
// would follow its rename to `videos_old`.
const REFERENCING_TABLES = {
  videos: `CREATE TABLE videos (
    id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT NOT NULL REFERENCES channels ON DELETE CASCADE,
    title TEXT,
    published TEXT,
    thumbnail TEXT,
    is_short INTEGER,
    views INTEGER,
    duration_s INTEGER,
    kind TEXT,
    notified_at TEXT,
    stats_at TEXT,
    title_words TEXT,
    first_seen TEXT,
    updated_at TEXT
  )`,
  favorites: 'CREATE TABLE favorites (video_id TEXT PRIMARY KEY REFERENCES videos ON DELETE CASCADE, added_at TEXT)',
  watched: 'CREATE TABLE watched (video_id TEXT PRIMARY KEY REFERENCES videos ON DELETE CASCADE, watched_at TEXT)',
  queue: 'CREATE TABLE queue (video_id TEXT PRIMARY KEY REFERENCES videos ON DELETE CASCADE, added_at TEXT, position INTEGER)',
  channel_topics: `CREATE TABLE channel_topics (
    channel_id TEXT REFERENCES channels ON DELETE CASCADE,
    topic_id TEXT REFERENCES topics ON DELETE CASCADE,
    PRIMARY KEY (channel_id, topic_id)
  )`,
  rules: `CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('mute', 'route')),
    pattern TEXT NOT NULL,
    words TEXT,
    channel_id TEXT REFERENCES channels ON DELETE CASCADE,
    topic_id TEXT REFERENCES topics ON DELETE CASCADE,
    CHECK (kind = 'mute' OR (channel_id IS NOT NULL AND topic_id IS NOT NULL))
  )`,
};

// Migration 3 moves referential integrity from the callers into the schema, so deleting a channel or a topic is one
// DELETE. It first deletes the rows that point at nothing. migrate() turns foreign_keys off around it, because the
// rebuild renames and drops tables that others reference. The rebuild keeps every rowid, and videos_fts is filled
// again from the rows that are left.
function addForeignKeys(db) {
  db.exec(`
    DELETE FROM videos WHERE id IS NULL OR channel_id NOT IN (SELECT id FROM channels);
    DELETE FROM favorites WHERE video_id NOT IN (SELECT id FROM videos);
    DELETE FROM watched WHERE video_id NOT IN (SELECT id FROM videos);
    DELETE FROM queue WHERE video_id NOT IN (SELECT id FROM videos);
    DELETE FROM channel_topics WHERE channel_id NOT IN (SELECT id FROM channels) OR topic_id NOT IN (SELECT id FROM topics);
    DELETE FROM rules WHERE (channel_id IS NOT NULL AND channel_id NOT IN (SELECT id FROM channels))
      OR (topic_id IS NOT NULL AND topic_id NOT IN (SELECT id FROM topics));
  `);
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type").all();
  for (const { type, name } of objects) db.exec(`DROP ${type.toUpperCase()} ${name}`);
  for (const [name, sql] of Object.entries(REFERENCING_TABLES)) rebuildTable(db, name, sql);
  for (const { sql } of objects) db.exec(sql);
  db.exec(`
    DELETE FROM videos_fts;
    INSERT INTO videos_fts (rowid, title, description)
      SELECT v.rowid, v.title, d.description FROM videos v LEFT JOIN video_descriptions d ON d.video_id = v.id;
  `);
  const broken = db.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) throw new Error(`migration 3 left rows that point at nothing: ${JSON.stringify(broken)}`);
}

// `announce` is 0 on a video that is never to be announced: one stored by a channel's first fetch, by a backfill, or
// while its channel was not a favorite. Before migration 4 nothing told those apart, so every video stored by then
// gets 0. `notified_at` keeps meaning that a notification announced the video.
function addAnnounce(db) {
  db.exec('ALTER TABLE videos ADD COLUMN announce INTEGER NOT NULL DEFAULT 1; UPDATE videos SET announce = 0');
}

// Migration 5 keeps each channel's backfill in the database, so a restart or a failed call continues from the page it
// reached instead of paying for the whole channel again. `playlist` and `page_token` name the next page to read, and a
// NULL playlist means the first page of the first one. `owner` is the one run, of the server or of bin/backfill.mjs, that
// holds a running row. It raises `heartbeat_at` while it lives, so another run can tell a live owner from a dead one.
// A database that lost `meta` runs every migration again, so the table may exist.
function backfillProgress(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS backfills (
    channel_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'error')),
    owner TEXT,
    heartbeat_at TEXT,
    playlist TEXT,
    page_token TEXT,
    units INTEGER NOT NULL DEFAULT 0,
    long_count INTEGER NOT NULL DEFAULT 0,
    short_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    queued_at TEXT,
    started_at TEXT,
    finished_at TEXT
  )`);
}

// Migration 6 keeps where the player stopped in each video, so opening it again on any device resumes there. A trigger
// deletes a video's place with the video, as for `video_descriptions`, instead of a foreign key: a database that lost
// `meta` runs migrations 1 and 3 again, and their rebuilds of `videos` would leave a key pointing at `videos_old`, or
// refuse the rows it already has.
function playbackPositions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (video_id TEXT PRIMARY KEY, seconds INTEGER NOT NULL, updated_at TEXT NOT NULL);
    DROP TRIGGER IF EXISTS positions_video_delete;
    CREATE TRIGGER positions_video_delete AFTER DELETE ON videos BEGIN DELETE FROM positions WHERE video_id = old.id; END;
  `);
}

// Append only. A database's user_version is the number of these it has run. A migration that ships is never edited.
const MIGRATIONS = [unifySchema, searchDescriptions, addForeignKeys, addAnnounce, backfillProgress, playbackPositions];

// Each migration runs in its own transaction, which takes the write lock first, so several processes opening the same
// file run each one once. A database without `meta` predates migrations, whatever its user_version says.
export function migrate(db) {
  // The pragma does nothing inside a transaction.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    runMigrations(db);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function runMigrations(db) {
  for (;;) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const hasMeta = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meta'").get();
      const done = hasMeta ? db.prepare('PRAGMA user_version').get().user_version : 0;
      if (done >= MIGRATIONS.length) {
        db.exec('COMMIT');
        return;
      }
      MIGRATIONS[done](db);
      db.exec(`PRAGMA user_version = ${done + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
