import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';

// Vite 5 predates node:sqlite; load the Node 22+ builtin without Vite resolution.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const databases: SqliteDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(legacy = false) {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  if (legacy) sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(',\n  metadata_json TEXT', ''));
  const prepare = (query: string) => {
    let values: any[] = [];
    return {
      bind(...args: unknown[]) { values = args; return this; },
      async run() { return sql.prepare(query).run(...values); },
      async first<T>(column?: string): Promise<T | null> {
        const row = sql.prepare(query).get(...values);
        return (row ? column ? row[column] : row : null) as T | null;
      },
      async all<T>() { return { results: sql.prepare(query).all(...values) as T[] }; },
    };
  };
  const env: Env = {
    SYNC_TOKEN: 'test-secret', VECTOR_DIMENSIONS: '2',
    DB: {
      prepare,
      async exec(query) { sql.exec(query); },
      async batch(statements) {
        sql.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sql.exec('COMMIT');
          return results;
        } catch (error) { sql.exec('ROLLBACK'); throw error; }
      },
    },
    VECTORS: { upsert: vi.fn(async () => ({})), query: vi.fn(async () => ({ matches: [] })), deleteByIds: vi.fn(async () => ({})) },
  };
  const request = (method: string, path = '/rest/v1/memory_vectors', body?: unknown) => worker.fetch(new Request(`https://example.test${path}`, {
    method,
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { sql, env, request };
}

const memory = { memory_id: 'm1', char_id: 'c1', content: 'original', vector: [1, 0], created_at: 1, importance: 8 };

describe('confirmed memory changes (real SQLite)', () => {
  it('finds cloud-only event dates and legacy headers without using insertion time', async () => {
    const { request } = setup();
    await request('POST', undefined, [
      { ...memory, memory_id: 'structured', metadata: { event_date: '2026-10-20' } },
      { ...memory, memory_id: 'legacy', content: '[2026-10-20]\n旅行' },
      { ...memory, memory_id: 'wrong', content: '提到2026-10-20' },
      { ...memory, memory_id: 'other', char_id: 'c2', metadata: { event_date: '2026-10-20' } },
      { ...memory, memory_id: 'archived', archived: true, metadata: { event_date: '2026-10-20' } },
    ]);
    const response = await request('GET', '/rest/v1/memory_vectors?char_id=eq.c1&archived=eq.false&event_date=2026-10-20');
    expect(response.status).toBe(200);
    expect((await response.json() as any[]).map(row => row.memory_id).sort()).toEqual(['legacy', 'structured']);
    expect((await request('GET', '/rest/v1/memory_vectors?char_id=eq.c1&event_date=2026-02-30')).status).toBe(400);
  });
  const sources = [{ role: 'user', content: '更正，我住在北京。' }, { role: 'assistant', content: '知道原因后，我不再觉得自己被忽视。' }];
  const draft = (action = 'correct_fact') => ({ char_id: 'c1', target_id: 'm1', action, content: action === 'correct_fact' ? '用户住在北京。' : '知道原因后，我不再觉得自己被忽视。', reason: '新对话明确纠正了旧记录', evidence: action === 'correct_fact' ? [sources[0].content] : sources.map(source => source.content), sources, base: { content: 'original', metadata: { kind: 'event' } } });
  it('only queues proposals until explicit confirmation; ignores duplicates and rejection changes no memory', async () => {
    const { request, env } = setup();
    await request('POST', undefined, { ...memory, metadata: { kind: 'event' } });
    vi.mocked(env.VECTORS.upsert).mockClear();
    const pending = await (await request('POST', '/memory/change-proposals', draft())).json() as any;
    expect(pending).toMatchObject({ status: 'pending', before: { content: 'original' }, content: '用户住在北京。' });
    expect(pending.before.vector).toBeUndefined();
    expect((await (await request('POST', '/memory/change-proposals', draft())).json() as any).id).toBe(pending.id);
    expect((await request('POST', `/memory/change-proposals/${pending.id}/approve`, { char_id: 'c1', vector: [0, 1], model: 'test' })).status).toBe(400);
    expect(env.VECTORS.upsert).not.toHaveBeenCalled();
    await request('POST', `/memory/change-proposals/${pending.id}/reject`, { char_id: 'c1' });
    expect((await (await request('POST', '/memory/change-proposals', draft())).json() as any).status).toBe('rejected');
    expect((await (await request('GET')).json() as any[])[0].content).toBe('original');
  });
  it('commits corrected text and vector together, preserving fields and prior evidence', async () => {
    const { request, sql } = setup();
    await request('POST', undefined, { ...memory, metadata: { kind: 'event' }, tags: ['北京'], room: 'user_room' });
    const pending = await (await request('POST', '/memory/change-proposals', draft())).json() as any;
    const oldKey = sql.prepare('SELECT vector_key FROM memory_vectors').get()!.vector_key;
    const response = await request('POST', `/memory/change-proposals/${pending.id}/approve`, { char_id: 'c1', confirmed: true, vector: [0, 1], model: 'test' });
    expect(response.status).toBe(200);
    expect((await response.json() as any).records[0]).toMatchObject({ memory_id: 'm1', content: '用户住在北京。', vector: '[0,1]', importance: 8, tags: ['北京'], room: 'user_room', metadata: { kind: 'event', review_revision: 1 } });
    expect(sql.prepare('SELECT vector_key FROM memory_vectors').get()!.vector_key).not.toBe(oldKey);
    expect(JSON.parse(sql.prepare('SELECT before_json FROM memory_change_proposals').get()!.before_json as string).target.content).toBe('original');
    expect((await request('POST', `/memory/change-proposals/${pending.id}/approve`, { char_id: 'c1', confirmed: true })).status).toBe(200);
    expect((await request('POST', undefined, memory)).status).toBe(409);
    expect((await request('PATCH', '/rest/v1/memory_vectors?memory_id=eq.m1', { content: 'old client overwrite' })).status).toBe(409);
    expect((await request('PATCH', '/rest/v1/memory_vectors?memory_id=eq.m1', { access_count: 9 })).status).toBe(200);
    const current = (await (await request('GET')).json() as any[])[0];
    const second = await (await request('POST', '/memory/change-proposals', { ...draft(), content: '用户现居深圳。', sources: [{ role: 'user', content: '我现在搬到深圳了。' }], evidence: ['我现在搬到深圳了。'], base: { content: current.content, metadata: current.metadata } })).json() as any;
    const revised = await (await request('POST', `/memory/change-proposals/${second.id}/approve`, { char_id: 'c1', confirmed: true, vector: [1, 1], model: 'test' })).json() as any;
    expect(revised.records[0]).toMatchObject({ content: '用户现居深圳。', metadata: { review_revision: 2 } });
  });
  it('appends reflection history and changes only the explicit current pointer; retries cannot create a second version', async () => {
    const { request, sql } = setup();
    const baseMetadata = { kind: 'event', current_reflection_id: 'old' };
    await request('POST', undefined, [{ ...memory, metadata: baseMetadata }, { ...memory, memory_id: 'old', content: '我觉得被忽视。', metadata: { kind: 'reflection', event_id: 'm1', confidence: 0.8 } }]);
    const pending = await (await request('POST', '/memory/change-proposals', { ...draft('revise_reflection'), base: { content: 'original', metadata: baseMetadata }, confidence: 0.45 })).json() as any;
    const body = { char_id: 'c1', confirmed: true, vector: [0, 1], model: 'test' };
    const result = await (await request('POST', `/memory/change-proposals/${pending.id}/approve`, body)).json() as any;
    const latest = result.records.find((row: any) => row.memory_id.startsWith('reflection_'));
    expect(latest.metadata).toMatchObject({ kind: 'reflection', event_id: 'm1', previous_id: 'old', confidence: 0.45, status: 'active' });
    expect(result.records.find((row: any) => row.memory_id === 'old')).toMatchObject({ archived: true, content: '我觉得被忽视。', metadata: { status: 'superseded' } });
    expect(result.records.find((row: any) => row.memory_id === 'm1').metadata.current_reflection_id).toBe(latest.memory_id);
    await request('POST', `/memory/change-proposals/${pending.id}/approve`, body);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()!.n).toBe(3);
  });
  it('refuses stale proposals and cross-character decisions', async () => {
    const { request } = setup();
    await request('POST', undefined, { ...memory, metadata: { kind: 'event' } });
    const pending = await (await request('POST', '/memory/change-proposals', draft())).json() as any;
    expect((await request('POST', `/memory/change-proposals/${pending.id}/approve`, { char_id: 'other', confirmed: true, vector: [0, 1], model: 'test' })).status).toBe(404);
    await request('PATCH', '/rest/v1/memory_vectors?memory_id=eq.m1', { content: '其他设备的新正文' });
    expect((await request('POST', `/memory/change-proposals/${pending.id}/approve`, { char_id: 'c1', confirmed: true, vector: [0, 1], model: 'test' })).status).toBe(409);
    expect((await request('POST', '/memory/change-proposals', draft())).status).toBe(409);
  });
  it('leaves live text and vectors intact if staging fails, or a competing write happens during staging', async () => {
    const { request, env, sql } = setup();
    await request('POST', undefined, { ...memory, metadata: { kind: 'event' } });
    const pending = await (await request('POST', '/memory/change-proposals', draft())).json() as any;
    const key = sql.prepare('SELECT vector_key FROM memory_vectors').get()!.vector_key;
    vi.mocked(env.VECTORS.upsert).mockRejectedValueOnce(new Error('staging failed'));
    const body = { char_id: 'c1', confirmed: true, vector: [0, 1], model: 'test' };
    expect((await request('POST', `/memory/change-proposals/${pending.id}/approve`, body)).status).toBe(500);
    expect(sql.prepare('SELECT content,vector_key FROM memory_vectors').get()).toEqual({ content: 'original', vector_key: key });
    vi.mocked(env.VECTORS.upsert).mockImplementationOnce(async () => { sql.prepare('UPDATE memory_vectors SET content=? WHERE memory_id=?').run('concurrent edit', 'm1'); return {}; });
    expect((await request('POST', `/memory/change-proposals/${pending.id}/approve`, body)).status).toBe(409);
    expect(sql.prepare('SELECT content,vector_key FROM memory_vectors').get()).toEqual({ content: 'concurrent edit', vector_key: key });
    expect(sql.prepare('SELECT status FROM memory_change_proposals').get()!.status).toBe('pending');
  });
  it('rejects invented evidence, identity edits and unlinked reflection updates', async () => {
    const { request } = setup();
    await request('POST', undefined, { ...memory, metadata: { kind: 'identity' } });
    expect((await request('POST', '/memory/change-proposals', { ...draft(), base: { content: 'original', metadata: { kind: 'identity' } } })).status).toBe(400);
    await request('POST', undefined, memory);
    expect((await request('POST', '/memory/change-proposals', { ...draft('revise_reflection'), base: { content: 'original', metadata: { kind: 'identity' } } })).status).toBe(400);
    await request('POST', undefined, { ...memory, metadata: { kind: 'event' } });
    expect((await request('POST', '/memory/change-proposals', { ...draft(), evidence: ['我凭空编造了这句话'] })).status).toBe(400);
  });
  it('never overwrites a rebuilt embedding or a competing importance change during confirmation', async () => {
    const { request, env, sql } = setup();
    await request('POST', undefined, { ...memory, metadata: { kind: 'event' } });
    const pending = await (await request('POST', '/memory/change-proposals', draft())).json() as any;
    sql.prepare('UPDATE memory_vectors SET model=? WHERE memory_id=?').run('rebuilt-model', 'm1');
    const body = { char_id: 'c1', confirmed: true, vector: [0, 1], model: 'test' };
    expect((await request('POST', `/memory/change-proposals/${pending.id}/approve`, body)).status).toBe(409);
    sql.prepare('UPDATE memory_vectors SET model=NULL WHERE memory_id=?').run('m1');
    vi.mocked(env.VECTORS.upsert).mockImplementationOnce(async () => { sql.prepare('UPDATE memory_vectors SET importance=10 WHERE memory_id=?').run('m1'); return {}; });
    expect((await request('POST', `/memory/change-proposals/${pending.id}/approve`, body)).status).toBe(409);
    expect(sql.prepare('SELECT content,importance FROM memory_vectors').get()).toEqual({ content: 'original', importance: 10 });
  });
});

describe('event box retirement (real SQLite)', () => {
  it('restores originals, keeps summary backups, preserves classification and isolates characters', async () => {
    const { request, sql, env } = setup();
    const nodes = [
      { ...memory, memory_id: 'raw', archived: true, event_box_id: 'box', metadata: { kind: 'event', current_reflection_id: 'reflection' } },
      { ...memory, memory_id: 'summary', is_summary: true, event_box_id: 'box', content: 'old mixed summary' },
      { ...memory, memory_id: 'other', char_id: 'c2', archived: true, event_box_id: 'other_box' },
      { ...memory, memory_id: 'reflection', archived: true, metadata: { kind: 'reflection', status: 'superseded', event_id: 'raw' } },
    ] as const;
    await request('POST', undefined, nodes);
    sql.prepare('INSERT INTO memory_event_box_policy(char_id) VALUES (?)').run('c1');
    expect(await (await request('GET', '/memory/event-box-policy?char_id=c1')).json()).toEqual({ disabled: true });
    expect(await (await request('GET', '/memory/event-box-policy?char_id=c2')).json()).toEqual({ disabled: false });
    const rows = await (await request('GET')).json() as any[];
    expect(rows.find(row => row.memory_id === 'raw')).toMatchObject({ archived: false, event_box_id: null, content: 'original', vector: '[1,0]', metadata: nodes[0].metadata });
    expect(rows.find(row => row.memory_id === 'summary')).toMatchObject({ archived: true, event_box_id: null, content: 'old mixed summary', vector: '[1,0]' });
    expect(rows.find(row => row.memory_id === 'other')).toMatchObject({ archived: true, event_box_id: 'other_box' });
    expect(rows.find(row => row.memory_id === 'reflection')).toMatchObject({ archived: true, metadata: nodes[3].metadata });
    expect(JSON.parse(sql.prepare('SELECT snapshot_json FROM memory_event_box_summary_backup').get()!.snapshot_json as string)).toMatchObject({ content: 'old mixed summary', vector_json: '[1,0]' });
    expect(sql.prepare('SELECT archived,event_box_id FROM memory_event_box_backup WHERE memory_id = ?').get('raw')).toEqual({ archived: 1, event_box_id: 'box' });
    const keys = sql.prepare('SELECT vector_key FROM memory_vectors WHERE char_id = ?').all('c1');
    vi.mocked(env.VECTORS.query).mockResolvedValue({ matches: keys.map(row => ({ id: row.vector_key as string, score: 0.9 })) });
    expect((await (await request('POST', '/rest/v1/rpc/match_vectors', { query_embedding: [1, 0], match_char_id: 'c1' })).json() as any[]).map(row => row.memory_id)).toEqual(['raw']);
    expect(env.VECTORS.deleteByIds).not.toHaveBeenCalled();
  });

  it('blocks old-client box flags on inserts and updates, including demoted summaries, without reviving reflection history', async () => {
    const { request, sql } = setup();
    await request('POST', undefined, { ...memory, memory_id: 'summary', is_summary: true, event_box_id: 'box' });
    sql.prepare('INSERT INTO memory_event_box_policy(char_id) VALUES (?)').run('c1');
    await request('POST', undefined, { ...memory, memory_id: 'summary', is_summary: false, archived: false });
    await request('PATCH', '/rest/v1/memory_vectors?memory_id=eq.summary', { archived: false });
    await request('POST', undefined, { ...memory, memory_id: 'new_raw', archived: true, event_box_id: 'recreated_box' });
    await request('POST', undefined, { ...memory, memory_id: 'new_summary', is_summary: true });
    await request('POST', undefined, { ...memory, memory_id: 'old_reflection', archived: true, metadata: { kind: 'reflection', status: 'superseded' } });
    const rows = await (await request('GET')).json() as any[];
    expect(rows.find(row => row.memory_id === 'summary')).toMatchObject({ is_summary: true, archived: true, event_box_id: null });
    expect(rows.find(row => row.memory_id === 'new_raw')).toMatchObject({ archived: false, event_box_id: null });
    expect(rows.find(row => row.memory_id === 'new_summary')).toMatchObject({ archived: true });
    expect(rows.find(row => row.memory_id === 'old_reflection')).toMatchObject({ archived: true });
  });

  it('rolls back policy, backups and changes together if the migration fails', async () => {
    const { request, sql } = setup();
    await request('POST', undefined, { ...memory, archived: true, event_box_id: 'box' });
    sql.exec("CREATE TRIGGER reject_retirement BEFORE UPDATE ON memory_vectors BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect(() => sql.prepare('INSERT INTO memory_event_box_policy(char_id) VALUES (?)').run('c1')).toThrow('test failure');
    expect(sql.prepare('SELECT COUNT(*) AS n FROM memory_event_box_policy').get()!.n).toBe(0);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM memory_event_box_backup').get()!.n).toBe(0);
    expect(sql.prepare('SELECT archived,event_box_id FROM memory_vectors').get()).toEqual({ archived: 1, event_box_id: 'box' });
  });
});

describe('memory metadata compatibility (real SQLite)', () => {
  it('searches all sources and characters, combines filters, and pages without sending vectors', async () => {
    const { request } = setup();
    await request('POST', undefined, [
      { ...memory, memory_id: 'original_a', content: '一起看星星', metadata: { kind: 'event' }, created_at: 3 },
      { ...memory, memory_id: 'original_b', char_id: 'c2', content: '看星星很开心', metadata: { kind: 'reflection' }, created_at: 2 },
      { ...memory, memory_id: 'lite_ctx_c', content: '以后再看星星', created_at: 1 },
    ]);
    const response = await request('GET', '/rest/v1/memory_vectors?q=星星&order=created_at.desc,memory_id.desc&limit=1&offset=1&select=memory_id,content,metadata');
    expect(response.headers.get('Content-Range')).toBe('1-1/3');
    expect(await response.json()).toEqual([{ memory_id: 'original_b', content: '看星星很开心', metadata: { kind: 'reflection' } }]);
    const facts = await request('GET', '/rest/v1/memory_vectors?q=星星&metadata.kind=eq.event&char_id=eq.c1');
    expect((await facts.json() as any[]).map(row => row.memory_id)).toEqual(['original_a']);
    const legacy = await request('GET', '/rest/v1/memory_vectors?q=星星&metadata.kind=is.null');
    expect((await legacy.json() as any[]).map(row => row.memory_id)).toEqual(['lite_ctx_c']);
    const empty = await request('GET', '/rest/v1/memory_vectors?q=不存在');
    expect(empty.headers.get('Content-Range')).toBe('*/0');
    expect(await empty.json()).toEqual([]);
  });

  it('treats search wildcards and SQL as literal text and can search IDs', async () => {
    const { request } = setup();
    await request('POST', undefined, [
      { ...memory, content: '100%_\\折扣' },
      { ...memory, memory_id: 'other', content: '10000折扣' },
    ]);
    for (const keyword of ['%_\\', 'm1']) {
      const response = await request('GET', `/rest/v1/memory_vectors?q=${encodeURIComponent(keyword)}`);
      expect((await response.json() as any[]).map(row => row.memory_id)).toEqual(['m1']);
    }
    const injection = await request('GET', `/rest/v1/memory_vectors?q=${encodeURIComponent("' OR 1=1 --")}`);
    expect(await injection.json()).toEqual([]);
    expect((await request('GET', `/rest/v1/memory_vectors?q=${'a'.repeat(201)}`)).status).toBe(400);
  });

  it('upgrades an existing database without altering its memories and can restart', async () => {
    const { sql, env, request } = setup(true);
    sql.prepare(`INSERT INTO memory_vectors (memory_id, vector_key, namespace_key, char_id, content, vector_json, created_at)
      VALUES ('old','old-key','c','c1','kept','[1,0]',1)`).run();
    expect((await request('GET', '/health')).status).toBe(200);
    const rows = await (await request('GET')).json() as any[];
    expect(rows[0]).toMatchObject({ memory_id: 'old', content: 'kept', metadata: {} });
    const freshBinding = { ...env, DB: { ...env.DB } };
    expect((await worker.fetch(new Request('https://example.test/health', { headers: { apikey: 'test-secret' } }), freshBinding)).status).toBe(200);
  });

  it('round-trips metadata and preserves it through old-client upserts and patches', async () => {
    const { request, env, sql } = setup();
    const metadata = { kind: 'reflection', event_id: 'e1', confidence: 0.45, extra: { future: true } };
    const saved = await request('POST', undefined, { ...memory, metadata });
    expect(saved.status).toBe(201);
    expect((await saved.json() as any[])[0].metadata).toEqual(metadata);
    const overwritten = await request('POST', undefined, { ...memory, content: 'edited by old client' });
    expect((await overwritten.json() as any[])[0]).toMatchObject({ metadata, content: 'edited by old client' });
    await request('PATCH', '/rest/v1/memory_vectors?memory_id=eq.m1', { importance: 9 });
    expect((await (await request('GET')).json() as any[])[0]).toMatchObject({ metadata, importance: 9 });
    const key = sql.prepare('SELECT vector_key FROM memory_vectors').get()!.vector_key as string;
    vi.mocked(env.VECTORS.query).mockResolvedValue({ matches: [{ id: key, score: 0.9 }] });
    const match = await request('POST', '/rest/v1/rpc/match_vectors', { query_embedding: [1, 0], match_char_id: 'c1' });
    expect((await match.json() as any[])[0].metadata).toEqual(metadata);
  });

  it('updates metadata without calling Vectorize and supports explicit clearing', async () => {
    const { request, env } = setup();
    await request('POST', undefined, { ...memory, metadata: { kind: 'event' } });
    vi.mocked(env.VECTORS.upsert).mockClear();
    const result = await request('PATCH', '/rest/v1/memory_vectors?memory_id=eq.m1', { metadata: { kind: 'identity' } });
    expect((await result.json() as any[])[0].metadata).toEqual({ kind: 'identity' });
    expect(env.VECTORS.upsert).not.toHaveBeenCalled();
    await request('PATCH', '/rest/v1/memory_vectors?memory_id=eq.m1', { metadata: {} });
    expect((await (await request('GET')).json() as any[])[0].metadata).toEqual({});
  });

  it('filters by metadata plus character and finds legacy records', async () => {
    const { request } = setup();
    await request('POST', undefined, [
      { ...memory, metadata: { kind: 'reflection', event_id: 'e1' } },
      { ...memory, memory_id: 'm2', char_id: 'c2', metadata: { kind: 'reflection', event_id: 'e1' } },
      { ...memory, memory_id: 'legacy' },
    ]);
    const response = await request('GET', '/rest/v1/memory_vectors?char_id=eq.c1&metadata.kind=eq.reflection&metadata.event_id=eq.e1');
    expect((await response.json() as any[]).map(row => row.memory_id)).toEqual(['m1']);
    expect(response.headers.get('Content-Range')).toBe('0-0/1');
    const legacy = await request('GET', '/rest/v1/memory_vectors?metadata.kind=is.null');
    expect((await legacy.json() as any[]).map(row => row.memory_id)).toEqual(['legacy']);
  });

  it('rejects malformed metadata and unknown filters before mutating records', async () => {
    const { request, env } = setup();
    for (const metadata of [null, [], 'bad', { big: '中'.repeat(6000) }]) {
      expect((await request('POST', undefined, { ...memory, metadata })).status).toBe(400);
    }
    expect(env.VECTORS.upsert).not.toHaveBeenCalled();
    await request('POST', undefined, { ...memory, metadata: { kind: 'event' } });
    expect((await request('PATCH', '/rest/v1/memory_vectors?metadata.typo=eq.event', { metadata: {} })).status).toBe(400);
    expect((await request('DELETE', '/rest/v1/memory_vectors?metadata.kind=neq.event')).status).toBe(400);
    expect((await (await request('GET')).json() as any[])[0].metadata).toEqual({ kind: 'event' });
  });
});
