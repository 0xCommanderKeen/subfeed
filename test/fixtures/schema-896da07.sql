-- The schema db.mjs created at commit 896da07, the first with rules and the last before title_words.
CREATE TABLE videos (
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
    first_seen TEXT,
    updated_at TEXT
  );
CREATE INDEX videos_channel_recent ON videos (channel_id, published DESC, id DESC, is_short);
CREATE INDEX videos_published ON videos (published, id);
CREATE TABLE favorites (video_id TEXT PRIMARY KEY, added_at TEXT);
CREATE TABLE watched (video_id TEXT PRIMARY KEY, watched_at TEXT);
CREATE TABLE queue (video_id TEXT PRIMARY KEY, added_at TEXT, position INTEGER);
CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER, hidden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    name TEXT,
    handle TEXT,
    subscribed INTEGER NOT NULL DEFAULT 1,
    favorite INTEGER NOT NULL DEFAULT 0,
    added_at TEXT,
    avatar TEXT
  );
CREATE TABLE channel_topics (channel_id TEXT, topic_id TEXT, PRIMARY KEY (channel_id, topic_id));
CREATE TABLE visits (group_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
CREATE TABLE api_units (day TEXT PRIMARY KEY, units INTEGER NOT NULL);
CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('mute', 'route')),
    pattern TEXT NOT NULL,
    channel_id TEXT,
    topic_id TEXT,
    CHECK (kind = 'mute' OR (channel_id IS NOT NULL AND topic_id IS NOT NULL))
  );
CREATE INDEX videos_missing_details ON videos (published DESC, id DESC)
    WHERE duration_s IS NULL AND (kind IS NULL OR kind IN ('upcoming', 'live'));
CREATE TABLE stats_version (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
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
CREATE VIRTUAL TABLE videos_fts USING fts5(title, content = 'videos', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
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
INSERT INTO stats_version VALUES (1, 0);
PRAGMA user_version = 0;
