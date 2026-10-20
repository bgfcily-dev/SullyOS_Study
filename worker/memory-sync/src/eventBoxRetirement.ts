/** Opt-in retirement per character. All backups stay in the same D1 database. */
const snapshotColumns = ['memory_id', 'vector_key', 'namespace_key', 'char_id', 'content', 'vector_json', 'dimensions', 'model', 'room', 'importance', 'tags_json', 'mood', 'valence', 'arousal', 'created_at', 'last_accessed_at', 'access_count', 'pinned_until', 'source_id', 'origin', 'archived', 'is_summary', 'event_box_id', 'metadata_json'];

export const eventBoxRetirementSchema = [
  `CREATE TABLE IF NOT EXISTS memory_event_box_policy (char_id TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 1 CHECK(disabled = 1))`,
  `CREATE TABLE IF NOT EXISTS memory_event_box_backup (memory_id TEXT PRIMARY KEY, char_id TEXT NOT NULL, archived INTEGER NOT NULL, is_summary INTEGER NOT NULL, event_box_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS memory_event_box_summary_backup (memory_id TEXT PRIMARY KEY, char_id TEXT NOT NULL, snapshot_json TEXT NOT NULL)`,
  // One policy insert performs the whole migration atomically, including backups.
  `CREATE TRIGGER IF NOT EXISTS memory_retire_event_boxes AFTER INSERT ON memory_event_box_policy
  BEGIN
    INSERT OR IGNORE INTO memory_event_box_backup SELECT memory_id, char_id, archived, is_summary, event_box_id FROM memory_vectors WHERE char_id = NEW.char_id;
    INSERT OR IGNORE INTO memory_event_box_summary_backup SELECT memory_id, char_id, json_object(${snapshotColumns.map(column => `'${column}', ${column}`).join(', ')}) FROM memory_vectors WHERE char_id = NEW.char_id AND is_summary = 1;
    UPDATE memory_vectors SET archived = CASE WHEN is_summary = 1 THEN 1 WHEN event_box_id IS NOT NULL THEN 0 ELSE archived END, event_box_id = NULL WHERE char_id = NEW.char_id;
  END`,
  ...['INSERT', 'UPDATE'].map(operation => `CREATE TRIGGER IF NOT EXISTS memory_no_event_boxes_${operation.toLowerCase()} AFTER ${operation} ON memory_vectors
  WHEN EXISTS (SELECT 1 FROM memory_event_box_policy WHERE char_id = NEW.char_id)
    AND (NEW.event_box_id IS NOT NULL OR (NEW.is_summary = 1 AND NEW.archived = 0)
      OR (NEW.is_summary = 0 AND EXISTS (SELECT 1 FROM memory_event_box_summary_backup WHERE memory_id = NEW.memory_id)))
  BEGIN
    UPDATE memory_vectors SET
      is_summary = CASE WHEN EXISTS (SELECT 1 FROM memory_event_box_summary_backup WHERE memory_id = NEW.memory_id) THEN 1 ELSE NEW.is_summary END,
      archived = CASE WHEN NEW.is_summary = 1 OR EXISTS (SELECT 1 FROM memory_event_box_summary_backup WHERE memory_id = NEW.memory_id) THEN 1 WHEN NEW.event_box_id IS NOT NULL THEN 0 ELSE NEW.archived END,
      event_box_id = NULL
    WHERE memory_id = NEW.memory_id;
  END`),
];
