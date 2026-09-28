/**
 * SullyOS personal memory sync backend (Cloudflare Worker + D1 + Vectorize).
 *
 * It intentionally implements the small PostgREST-compatible surface already
 * used by SullyOS, so the existing remote-vector and recent-context clients can
 * point at this Worker without a second client implementation.
 */

export interface Env {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  SYNC_TOKEN?: string;
  VECTOR_DIMENSIONS?: string;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec(query: string): Promise<unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

interface VectorizeIndex {
  upsert(vectors: Array<{ id: string; values: number[]; namespace?: string }>): Promise<unknown>;
  query(vector: number[], options: { topK: number; namespace?: string }): Promise<{ matches?: Array<{ id: string; score: number }> }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

interface MemoryInput extends Record<string, unknown> {
  memory_id?: unknown;
  char_id?: unknown;
  vector?: unknown;
}

interface MemoryRow extends Record<string, unknown> {
  memory_id: string;
  vector_key: string;
  namespace_key: string;
  char_id: string;
  content: string;
  vector_json: string;
  dimensions: number;
  model: string | null;
  room: string | null;
  importance: number;
  tags_json: string;
  mood: string;
  valence: number | null;
  arousal: number | null;
  created_at: number;
  last_accessed_at: number;
  access_count: number;
  pinned_until: number | null;
  source_id: string | null;
  origin: string | null;
  archived: number;
  is_summary: number;
  event_box_id: string | null;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,apikey,Prefer',
  'Access-Control-Expose-Headers': 'Content-Range',
  'Access-Control-Max-Age': '86400',
};

const json = (data: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders },
  });

const empty = (status = 204, extraHeaders: Record<string, string> = {}) =>
  new Response(null, { status, headers: { ...CORS, ...extraHeaders } });

let schemaReady = false;

async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS memory_vectors (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memory_vectors_char ON memory_vectors(char_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_vectors_room ON memory_vectors(char_id, room)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_vectors_archived ON memory_vectors(char_id, archived)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_vectors_event_box ON memory_vectors(event_box_id)`,
    `CREATE TABLE IF NOT EXISTS shared_recent_contexts (
      brain_id TEXT PRIMARY KEY,
      char_id TEXT NOT NULL DEFAULT '',
      messages_json TEXT NOT NULL DEFAULT '[]',
      source_device_id TEXT NOT NULL DEFAULT '',
      source_device_name TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`,
  ];
  for (const statement of statements) await db.exec(`${statement};`);
  schemaReady = true;
}

function authorized(request: Request, env: Env): boolean {
  const expected = env.SYNC_TOKEN?.trim();
  if (!expected) return false;
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return bearer === expected || request.headers.get('apikey')?.trim() === expected;
}

function preferRepresentation(request: Request): boolean {
  return (request.headers.get('Prefer') || '').toLowerCase().includes('return=representation');
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolInt(value: unknown): number {
  return value === true || value === 1 || value === 'true' ? 1 : 0;
}

export function parseVectorInput(value: unknown): number[] | null {
  let raw: unknown = value;
  if (typeof value === 'string') {
    const clean = value.trim();
    try {
      raw = JSON.parse(clean.startsWith('[') ? clean : `[${clean}]`);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const vector = raw.map(Number);
  return vector.every(Number.isFinite) ? vector : null;
}

async function hashKey(prefix: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  // Vectorize IDs and namespaces are limited to 64 bytes. Two prefix bytes +
  // 62 hex chars retain 248 bits of the digest and keep the value ASCII-only.
  return `${prefix}${hex.slice(0, 62)}`;
}

function safeJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function memoryToPublic(row: MemoryRow): Record<string, unknown> {
  let tags: unknown[] = [];
  try { tags = safeJsonArray(JSON.parse(row.tags_json || '[]')); } catch { tags = []; }
  return {
    memory_id: row.memory_id,
    char_id: row.char_id,
    content: row.content,
    vector: row.vector_json,
    dimensions: row.dimensions,
    model: row.model,
    room: row.room,
    importance: row.importance,
    tags,
    mood: row.mood,
    valence: row.valence,
    arousal: row.arousal,
    created_at: row.created_at,
    last_accessed_at: row.last_accessed_at,
    access_count: row.access_count,
    pinned_until: row.pinned_until,
    source_id: row.source_id,
    origin: row.origin,
    archived: Boolean(row.archived),
    is_summary: Boolean(row.is_summary),
    event_box_id: row.event_box_id,
  };
}

async function normalizeMemory(input: MemoryInput, expectedDimensions: number): Promise<{ row: MemoryRow; vector: number[] }> {
  const memoryId = String(input.memory_id || '').trim();
  const charId = String(input.char_id || '').trim();
  const vector = parseVectorInput(input.vector);
  if (!memoryId || !charId || !vector) throw new Error('memory_id、char_id 和 vector 都是必填项');
  const dimensions = Math.trunc(numberValue(input.dimensions, vector.length));
  if (dimensions !== vector.length) throw new Error(`向量长度 ${vector.length} 与 dimensions ${dimensions} 不一致`);
  if (dimensions !== expectedDimensions) throw new Error(`此 Vectorize 索引要求 ${expectedDimensions} 维向量，收到 ${dimensions} 维`);
  const now = Date.now();
  const vectorKey = await hashKey('m_', memoryId);
  const namespaceKey = await hashKey('c_', charId);
  const row: MemoryRow = {
    memory_id: memoryId,
    vector_key: vectorKey,
    namespace_key: namespaceKey,
    char_id: charId,
    content: String(input.content || ''),
    vector_json: JSON.stringify(vector),
    dimensions,
    model: input.model == null ? null : String(input.model),
    room: input.room == null ? null : String(input.room),
    importance: Math.trunc(numberValue(input.importance, 5)),
    tags_json: JSON.stringify(safeJsonArray(input.tags).map(String)),
    mood: String(input.mood || ''),
    valence: nullableNumber(input.valence),
    arousal: nullableNumber(input.arousal),
    created_at: Math.trunc(numberValue(input.created_at, now)),
    last_accessed_at: Math.trunc(numberValue(input.last_accessed_at, numberValue(input.created_at, now))),
    access_count: Math.trunc(numberValue(input.access_count, 0)),
    pinned_until: nullableNumber(input.pinned_until),
    source_id: input.source_id == null ? null : String(input.source_id),
    origin: input.origin == null ? null : String(input.origin),
    archived: boolInt(input.archived),
    is_summary: boolInt(input.is_summary),
    event_box_id: input.event_box_id == null ? null : String(input.event_box_id),
  };
  return { row, vector };
}

const UPSERT_SQL = `INSERT INTO memory_vectors (
  memory_id, vector_key, namespace_key, char_id, content, vector_json, dimensions, model, room,
  importance, tags_json, mood, valence, arousal, created_at, last_accessed_at, access_count,
  pinned_until, source_id, origin, archived, is_summary, event_box_id
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(memory_id) DO UPDATE SET
  vector_key=excluded.vector_key, namespace_key=excluded.namespace_key, char_id=excluded.char_id,
  content=excluded.content, vector_json=excluded.vector_json, dimensions=excluded.dimensions,
  model=excluded.model, room=excluded.room, importance=excluded.importance, tags_json=excluded.tags_json,
  mood=excluded.mood, valence=excluded.valence, arousal=excluded.arousal, created_at=excluded.created_at,
  last_accessed_at=excluded.last_accessed_at, access_count=excluded.access_count,
  pinned_until=excluded.pinned_until, source_id=excluded.source_id, origin=excluded.origin,
  archived=excluded.archived, is_summary=excluded.is_summary, event_box_id=excluded.event_box_id`;

function bindMemory(db: D1Database, row: MemoryRow): D1PreparedStatement {
  return db.prepare(UPSERT_SQL).bind(
    row.memory_id, row.vector_key, row.namespace_key, row.char_id, row.content, row.vector_json,
    row.dimensions, row.model, row.room, row.importance, row.tags_json, row.mood, row.valence,
    row.arousal, row.created_at, row.last_accessed_at, row.access_count, row.pinned_until,
    row.source_id, row.origin, row.archived, row.is_summary, row.event_box_id,
  );
}

async function upsertMemories(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as MemoryInput | MemoryInput[];
  const inputs = Array.isArray(body) ? body : [body];
  if (inputs.length === 0 || inputs.length > 100) return json({ error: '单次需要上传 1 到 100 条记忆' }, 400);
  const expectedDimensions = Math.trunc(numberValue(env.VECTOR_DIMENSIONS, 1024));
  const normalized = await Promise.all(inputs.map((input) => normalizeMemory(input, expectedDimensions)));
  await env.DB.batch(normalized.map(({ row }) => bindMemory(env.DB, row)));
  await env.VECTORS.upsert(normalized.map(({ row, vector }) => ({ id: row.vector_key, values: vector, namespace: row.namespace_key })));
  return preferRepresentation(request) ? json(normalized.map(({ row }) => memoryToPublic(row)), 201) : empty(204);
}

type Filter = { sql: string; values: unknown[] };

function memoryFilter(url: URL): Filter {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const charId = url.searchParams.get('char_id');
  if (charId?.startsWith('eq.')) { clauses.push('char_id = ?'); values.push(charId.slice(3)); }
  const room = url.searchParams.get('room');
  if (room?.startsWith('eq.')) { clauses.push('room = ?'); values.push(room.slice(3)); }
  const archived = url.searchParams.get('archived');
  if (archived?.startsWith('eq.')) { clauses.push('archived = ?'); values.push(boolInt(archived.slice(3))); }
  const memoryId = url.searchParams.get('memory_id');
  if (memoryId?.startsWith('eq.')) {
    clauses.push('memory_id = ?');
    values.push(memoryId.slice(3));
  } else if (memoryId?.startsWith('in.(') && memoryId.endsWith(')')) {
    const ids = memoryId.slice(4, -1).split(',').map((id) => id.trim()).filter(Boolean).slice(0, 1000);
    if (ids.length) { clauses.push(`memory_id IN (${ids.map(() => '?').join(',')})`); values.push(...ids); }
  } else if (memoryId?.startsWith('like.')) {
    const pattern = memoryId.slice(5).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/\*/g, '%');
    clauses.push(`memory_id LIKE ? ESCAPE '\\'`);
    values.push(pattern);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
}

const SORT_FIELDS = new Set(['memory_id', 'char_id', 'created_at', 'last_accessed_at', 'importance', 'room']);

function memoryOrder(url: URL): string {
  const terms = (url.searchParams.get('order') || '').split(',').flatMap((term) => {
    const [field, direction] = term.split('.');
    return SORT_FIELDS.has(field) ? [`${field} ${direction === 'desc' ? 'DESC' : 'ASC'}`] : [];
  });
  return terms.length ? ` ORDER BY ${terms.join(', ')}` : '';
}

async function selectMemoryRows(db: D1Database, url: URL, withPaging = true): Promise<MemoryRow[]> {
  const filter = memoryFilter(url);
  let query = `SELECT * FROM memory_vectors${filter.sql}${memoryOrder(url)}`;
  const values = [...filter.values];
  if (withPaging) {
    const limit = Math.min(1000, Math.max(0, Math.trunc(numberValue(url.searchParams.get('limit'), 1000))));
    const offset = Math.max(0, Math.trunc(numberValue(url.searchParams.get('offset'), 0)));
    query += ' LIMIT ? OFFSET ?';
    values.push(limit, offset);
  }
  return (await db.prepare(query).bind(...values).all<MemoryRow>()).results;
}

async function getMemories(request: Request, env: Env, url: URL): Promise<Response> {
  const filter = memoryFilter(url);
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM memory_vectors${filter.sql}`).bind(...filter.values).first<{ total: number }>();
  const total = Number(countRow?.total || 0);
  if (request.method === 'HEAD') return empty(200, { 'Content-Range': `0-0/${total}` });
  const rows = await selectMemoryRows(env.DB, url);
  return json(rows.map(memoryToPublic), 200, { 'Content-Range': rows.length ? `0-${rows.length - 1}/${total}` : `*/${total}` });
}

const PATCH_COLUMNS: Record<string, { column: string; value: (input: unknown) => unknown }> = {
  content: { column: 'content', value: (value) => String(value || '') },
  room: { column: 'room', value: (value) => value == null ? null : String(value) },
  importance: { column: 'importance', value: (value) => Math.trunc(numberValue(value, 5)) },
  tags: { column: 'tags_json', value: (value) => JSON.stringify(safeJsonArray(value).map(String)) },
  mood: { column: 'mood', value: (value) => String(value || '') },
  valence: { column: 'valence', value: nullableNumber },
  arousal: { column: 'arousal', value: nullableNumber },
  last_accessed_at: { column: 'last_accessed_at', value: (value) => Math.trunc(numberValue(value)) },
  access_count: { column: 'access_count', value: (value) => Math.trunc(numberValue(value)) },
  pinned_until: { column: 'pinned_until', value: nullableNumber },
  source_id: { column: 'source_id', value: (value) => value == null ? null : String(value) },
  origin: { column: 'origin', value: (value) => value == null ? null : String(value) },
  archived: { column: 'archived', value: boolInt },
  is_summary: { column: 'is_summary', value: boolInt },
  event_box_id: { column: 'event_box_id', value: (value) => value == null ? null : String(value) },
};

async function patchMemories(request: Request, env: Env, url: URL): Promise<Response> {
  const payload = await request.json() as Record<string, unknown>;
  const updates = Object.entries(payload).flatMap(([key, value]) => {
    const spec = PATCH_COLUMNS[key];
    return spec ? [{ column: spec.column, value: spec.value(value) }] : [];
  });
  if (!updates.length) return json({ error: '没有可更新的字段' }, 400);
  const filter = memoryFilter(url);
  if (!filter.sql) return json({ error: 'PATCH 必须带筛选条件' }, 400);
  const sql = `UPDATE memory_vectors SET ${updates.map(({ column }) => `${column} = ?`).join(', ')}${filter.sql}`;
  await env.DB.prepare(sql).bind(...updates.map(({ value }) => value), ...filter.values).run();
  if (!preferRepresentation(request)) return empty(204);
  const rows = await selectMemoryRows(env.DB, url, false);
  return json(rows.map(memoryToPublic));
}

async function deleteVectorKeys(index: VectorizeIndex, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) await index.deleteByIds(keys.slice(i, i + 1000));
}

async function deleteMemories(request: Request, env: Env, url: URL): Promise<Response> {
  const filter = memoryFilter(url);
  const explicitClearAll = url.searchParams.get('memory_id') === 'not.is.null';
  if (!filter.sql && !explicitClearAll) return json({ error: 'DELETE 必须带筛选条件' }, 400);
  const rows = await selectMemoryRows(env.DB, url, false);
  await deleteVectorKeys(env.VECTORS, rows.map((row) => row.vector_key));
  await env.DB.prepare(`DELETE FROM memory_vectors${filter.sql}`).bind(...filter.values).run();
  return preferRepresentation(request) ? json(rows.map(memoryToPublic)) : empty(204);
}

async function matchVectors(request: Request, env: Env): Promise<Response> {
  const input = await request.json() as Record<string, unknown>;
  const queryVector = parseVectorInput(input.query_embedding);
  const charId = String(input.match_char_id || '').trim();
  const dimensions = Math.trunc(numberValue(env.VECTOR_DIMENSIONS, 1024));
  if (!queryVector || !charId) return json({ error: 'query_embedding 和 match_char_id 是必填项' }, 400);
  if (queryVector.length !== dimensions) return json({ error: `此 Vectorize 索引要求 ${dimensions} 维向量` }, 400);
  const threshold = numberValue(input.match_threshold, 0.3);
  const count = Math.min(50, Math.max(1, Math.trunc(numberValue(input.match_count, 20))));
  const namespace = await hashKey('c_', charId);
  // Archived vectors remain in Vectorize so unarchiving is only a D1 update.
  // Ask for spare candidates, filter archived rows in D1, then apply match_count.
  const candidateCount = Math.min(100, Math.max(count, count * 3));
  const result = await env.VECTORS.query(queryVector, { topK: candidateCount, namespace });
  const matches = (result.matches || []).filter((match) => numberValue(match.score) > threshold);
  if (!matches.length) return json([]);
  const keys = matches.map((match) => match.id);
  const rows = (await env.DB.prepare(`SELECT * FROM memory_vectors WHERE archived = 0 AND vector_key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all<MemoryRow>()).results;
  const byKey = new Map(rows.map((row) => [row.vector_key, row]));
  return json(matches.flatMap((match) => {
    const row = byKey.get(match.id);
    return row ? [{ ...memoryToPublic(row), similarity: numberValue(match.score) }] : [];
  }).slice(0, count));
}

interface ContextRow {
  brain_id: string;
  char_id: string;
  messages_json: string;
  source_device_id: string;
  source_device_name: string;
  revision: number;
  updated_at: number;
}

function contextToPublic(row: ContextRow): Record<string, unknown> {
  let messages: unknown[] = [];
  try { messages = safeJsonArray(JSON.parse(row.messages_json || '[]')); } catch { messages = []; }
  return { ...row, messages, messages_json: undefined };
}

async function sharedContexts(request: Request, env: Env, url: URL): Promise<Response> {
  const brainFilter = url.searchParams.get('brain_id');
  const brainId = brainFilter?.startsWith('eq.') ? brainFilter.slice(3) : 'primary';
  if (request.method === 'GET' || request.method === 'HEAD') {
    const row = await env.DB.prepare('SELECT * FROM shared_recent_contexts WHERE brain_id = ? LIMIT 1').bind(brainId).first<ContextRow>();
    if (request.method === 'HEAD') return empty(200, { 'Content-Range': row ? '0-0/1' : '*/0' });
    return json(row ? [contextToPublic(row)] : []);
  }
  if (request.method === 'POST') {
    const input = await request.json() as Record<string, unknown>;
    const messages = safeJsonArray(input.messages).slice(-30);
    const row: ContextRow = {
      brain_id: String(input.brain_id || 'primary'),
      char_id: String(input.char_id || ''),
      messages_json: JSON.stringify(messages),
      source_device_id: String(input.source_device_id || ''),
      source_device_name: String(input.source_device_name || ''),
      revision: Math.max(1, Math.trunc(numberValue(input.revision, 1))),
      updated_at: Math.trunc(numberValue(input.updated_at, Date.now())),
    };
    await env.DB.prepare(`INSERT INTO shared_recent_contexts (brain_id,char_id,messages_json,source_device_id,source_device_name,revision,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(brain_id) DO UPDATE SET char_id=excluded.char_id,messages_json=excluded.messages_json,
      source_device_id=excluded.source_device_id,source_device_name=excluded.source_device_name,revision=excluded.revision,updated_at=excluded.updated_at`)
      .bind(row.brain_id, row.char_id, row.messages_json, row.source_device_id, row.source_device_name, row.revision, row.updated_at).run();
    return preferRepresentation(request) ? json([contextToPublic(row)], 201) : empty(204);
  }
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM shared_recent_contexts WHERE brain_id = ?').bind(brainId).run();
    return empty(204);
  }
  return json({ error: 'Method not allowed' }, 405);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return empty(204);
    if (!env.SYNC_TOKEN?.trim()) return json({ error: 'Worker 尚未设置 SYNC_TOKEN secret' }, 503);
    if (!authorized(request, env)) return json({ error: '认证失败' }, 401);

    try {
      await ensureSchema(env.DB);
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/health') return json({ ok: true, backend: 'cloudflare-memory-sync' });
      if (path === '/rest/v1/rpc/match_vectors' && request.method === 'POST') return await matchVectors(request, env);
      if (path === '/rest/v1/shared_recent_contexts') return await sharedContexts(request, env, url);
      if (path === '/rest/v1/memory_vectors') {
        if (request.method === 'GET' || request.method === 'HEAD') return await getMemories(request, env, url);
        if (request.method === 'POST') return await upsertMemories(request, env);
        if (request.method === 'PATCH') return await patchMemories(request, env, url);
        if (request.method === 'DELETE') return await deleteMemories(request, env, url);
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, message.includes('必填') || message.includes('向量') ? 400 : 500);
    }
  },
};
