-- The schema db.mjs created at commit a6fb071, the first with channels and topics.
CREATE TABLE videos (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    title TEXT,
    published TEXT,
    thumbnail TEXT,
    is_short INTEGER,
    views INTEGER,
    duration_s INTEGER,
    first_seen TEXT,
    updated_at TEXT
  );
CREATE INDEX videos_channel_published ON videos (channel_id, published);
CREATE INDEX videos_published ON videos (published, id);
CREATE TABLE favorites (video_id TEXT PRIMARY KEY, added_at TEXT);
CREATE TABLE watched (video_id TEXT PRIMARY KEY, watched_at TEXT);
CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER);
CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    name TEXT,
    handle TEXT,
    subscribed INTEGER NOT NULL DEFAULT 1,
    favorite INTEGER NOT NULL DEFAULT 0,
    added_at TEXT
  );
CREATE TABLE channel_topics (channel_id TEXT, topic_id TEXT, PRIMARY KEY (channel_id, topic_id));
PRAGMA user_version = 0;
