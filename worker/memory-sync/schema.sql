CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY,
  vector_key TEXT NOT NULL UNIQUE,
  namespace_key TEXT NOT NULL,
  char_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  vector_json TEXT NOT NULL,
  dimensions INTEGER NOT NULL DEFAULT 1024,
  model TEXT,
  room TEXT,
  importance INTEGER NOT NULL DEFAULT 5,
  tags_json TEXT NOT NULL DEFAULT '[]',
  mood TEXT NOT NULL DEFAULT '',
  valence REAL,
  arousal REAL,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL DEFAULT 0,
  access_count INTEGER NOT NULL DEFAULT 0,
  pinned_until INTEGER,
  source_id TEXT,
  origin TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  is_summary INTEGER NOT NULL DEFAULT 0,
  event_box_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_vectors_char ON memory_vectors(char_id);
CREATE INDEX IF NOT EXISTS idx_memory_vectors_room ON memory_vectors(char_id, room);
CREATE INDEX IF NOT EXISTS idx_memory_vectors_archived ON memory_vectors(char_id, archived);
CREATE INDEX IF NOT EXISTS idx_memory_vectors_event_box ON memory_vectors(event_box_id);

CREATE TABLE IF NOT EXISTS shared_recent_contexts (
  brain_id TEXT PRIMARY KEY,
  char_id TEXT NOT NULL DEFAULT '',
  messages_json TEXT NOT NULL DEFAULT '[]',
  source_device_id TEXT NOT NULL DEFAULT '',
  source_device_name TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
