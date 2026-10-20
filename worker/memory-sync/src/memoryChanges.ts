import { stableJson, validateChangeDraft, type ChangeMemory } from '../../../utils/memoryPalace/changeContract';
import type { Env, MemoryRow } from './index';

export const memoryChangesSchema = [
  `CREATE TABLE IF NOT EXISTS memory_change_proposals (id TEXT PRIMARY KEY, char_id TEXT NOT NULL, target_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT NOT NULL, draft_json TEXT NOT NULL, source_json TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), created_at INTEGER NOT NULL, resolved_at INTEGER, result_json TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_changes_pending ON memory_change_proposals(char_id,status,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS memory_change_guards (proposal_id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid = 1))`,
];
interface ProposalRow { id: string; char_id: string; target_id: string; action: string; before_json: string; draft_json: string; status: string; created_at: number; result_json: string | null }
interface Services {
  publicMemory(row: MemoryRow): Record<string, unknown>;
  normalize(input: Record<string, unknown>, dimensions: number): Promise<{ row: MemoryRow; vector: number[] }>;
  bind(row: MemoryRow): ReturnType<Env['DB']['prepare']>;
  hash(prefix: string, value: string): Promise<string>;
  json(data: unknown, status?: number, headers?: Record<string, string>): Response;
}
const metadata = (row: MemoryRow) => JSON.parse(row.metadata_json || '{}') as Record<string, unknown>;
const active = (row: MemoryRow) => !row.archived && !row.is_summary && (!metadata(row).status || metadata(row).status === 'active');
// A proposal approves a particular complete version, including its embedding model.
const versionFields: Array<keyof MemoryRow> = ['memory_id', 'char_id', 'content', 'metadata_json', 'archived', 'is_summary', 'vector_key', 'namespace_key', 'vector_json', 'dimensions', 'model', 'room', 'importance', 'tags_json', 'mood', 'valence', 'arousal', 'created_at', 'last_accessed_at', 'access_count', 'pinned_until', 'source_id', 'origin', 'event_box_id'];

export async function handleMemoryChanges(request: Request, env: Env, url: URL, svc: Services): Promise<Response> {
  const load = (id: string, charId: string) => env.DB.prepare('SELECT * FROM memory_vectors WHERE memory_id = ? AND char_id = ?').bind(id, charId).first<MemoryRow>();
  const snapshot = (row: MemoryRow | null) => {
    if (!row) return null;
    const value = svc.publicMemory(row); delete value.vector; return value;
  };
  const publicProposal = (row: ProposalRow) => {
    const before = JSON.parse(row.before_json) as { target: MemoryRow; current: MemoryRow | null };
    return { ...JSON.parse(row.draft_json), id: row.id, char_id: row.char_id, status: row.status, created_at: row.created_at, before: snapshot(before.target), current_reflection: snapshot(before.current) };
  };
  const fail = (error: string, status = 400) => svc.json({ error }, status);
  const root = '/memory/change-proposals';
  if (url.pathname === root && request.method === 'GET') {
    const charId = url.searchParams.get('char_id')?.trim();
    if (!charId) return fail('必须指定当前角色');
    const status = url.searchParams.get('status') || 'pending';
    if (!['pending', 'approved', 'rejected'].includes(status)) return fail('提案状态无效');
    const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('offset')) || 0));
    const rows = await env.DB.prepare('SELECT * FROM memory_change_proposals WHERE char_id = ? AND status = ? ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?').bind(charId, status, offset).all<ProposalRow>();
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM memory_change_proposals WHERE char_id = ? AND status = ?').bind(charId, status).first<{ n: number }>();
    return svc.json({ proposals: rows.results.map(publicProposal), total: count?.n || 0 });
  }
  const input = await request.json() as Record<string, any>;
  const charId = typeof input.char_id === 'string' ? input.char_id.trim() : '';
  if (!charId) return fail('必须指定当前角色');
  if (url.pathname === root && request.method === 'POST') {
    const target = await load(String(input.target_id || ''), charId);
    if (!target) return fail('原记忆不存在或属于其他角色', 404);
    if (!input.base || input.base.content !== target.content || stableJson(input.base.metadata || {}) !== stableJson(metadata(target))) return fail('原记忆已变化，请重新生成修改提案', 409);
    const sources = input.sources;
    if (!Array.isArray(sources) || !sources.length || sources.length > 6 || !sources.every(value => value && ['user', 'assistant'].includes(value.role) && typeof value.content === 'string' && value.content.length <= 12000)) return fail('本次对话来源无效');
    let draft;
    try { draft = validateChangeDraft(input, svc.publicMemory(target) as unknown as ChangeMemory, sources); } catch (error) { return fail((error as Error).message); }
    const currentId = metadata(target).current_reflection_id;
    const current = draft.action === 'revise_reflection' && typeof currentId === 'string' ? await load(currentId, charId) : null;
    if (currentId && draft.action === 'revise_reflection' && (!current || !active(current) || metadata(current).kind !== 'reflection' || metadata(current).event_id !== target.memory_id)) return fail('当前感想关联无效，请先检查原记忆', 409);
    const prior = draft.action === 'correct_fact' ? target : current;
    if (prior && draft.content === prior.content && (draft.confidence === undefined || draft.confidence === metadata(prior).confidence) && (draft.mood === undefined || draft.mood === prior.mood)) return fail('提案没有实质变化');
    const before = { target, current };
    const dedupe = await svc.hash('p_', stableJson([charId, versionFields.map(field => target[field] ?? null), current ? versionFields.map(field => current[field] ?? null) : null, draft.action, draft.content, draft.confidence, draft.mood]));
    await env.DB.prepare('INSERT OR IGNORE INTO memory_change_proposals(id,char_id,target_id,action,before_json,draft_json,source_json,dedupe_key,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(), charId, target.memory_id, draft.action, JSON.stringify(before), JSON.stringify(draft), JSON.stringify(sources), dedupe, Date.now()).run();
    const saved = await env.DB.prepare('SELECT * FROM memory_change_proposals WHERE dedupe_key = ? AND char_id = ?').bind(dedupe, charId).first<ProposalRow>();
    return svc.json(publicProposal(saved!), 201);
  }
  const decision = /^\/memory\/change-proposals\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
  if (!decision || request.method !== 'POST') return fail('Not found', 404);
  const proposal = await env.DB.prepare('SELECT * FROM memory_change_proposals WHERE id = ? AND char_id = ?').bind(decision[1], charId).first<ProposalRow>();
  if (!proposal) return fail('提案不存在或属于其他角色', 404);
  if (decision[2] === 'reject') {
    if (proposal.status === 'approved') return fail('提案已经确认，不能再忽略', 409);
    await env.DB.prepare("UPDATE memory_change_proposals SET status='rejected',resolved_at=? WHERE id=? AND char_id=? AND status='pending'").bind(Date.now(), proposal.id, charId).run();
    const resolved = await env.DB.prepare('SELECT status FROM memory_change_proposals WHERE id=? AND char_id=?').bind(proposal.id, charId).first<{ status: string }>();
    if (resolved?.status !== 'rejected') return fail('提案已在其他设备确认，请刷新查看', 409);
    return svc.json({ status: 'rejected' });
  }
  if (input.confirmed !== true) return fail('需要用户在确认页主动确认');
  const approvedResult = async (saved: ProposalRow) => {
    const ids = JSON.parse(saved.result_json || '[]') as string[];
    const rows = await Promise.all(ids.map(id => load(id, charId)));
    return svc.json({ status: 'approved', records: rows.filter((row): row is MemoryRow => !!row).map(svc.publicMemory) });
  };
  if (proposal.status === 'approved') return approvedResult(proposal);
  if (proposal.status !== 'pending') return fail('这个提案已被忽略', 409);
  const before = JSON.parse(proposal.before_json) as { target: MemoryRow; current: MemoryRow | null };
  const draft = JSON.parse(proposal.draft_json) as { content: string; confidence?: number; mood?: string };
  const target = await load(proposal.target_id, charId);
  const same = (a: MemoryRow | null, b: MemoryRow) => !!a && active(a) && versionFields.every(field => (a[field] ?? null) === (b[field] ?? null));
  if (!same(target, before.target)) return fail('原记忆已变化，旧提案不能覆盖新版本。请忽略后重新评估', 409);
  if (before.current && !same(await load(before.current.memory_id, charId), before.current)) return fail('当前感想已变化，请重新评估', 409);
  const suppliedVector = input.vector;
  if (!Array.isArray(suppliedVector) || suppliedVector.length !== Number(env.VECTOR_DIMENSIONS || 1024) || !suppliedVector.every(value => typeof value === 'number' && Number.isFinite(value)) || typeof input.model !== 'string' || !input.model.trim()) return fail('确认修改需要有效的新正文向量及模型');
  const modelName = (value: string) => value.replace(/^Pro\//i, '').trim().toLowerCase();
  if (target!.model && modelName(target!.model) !== modelName(input.model)) return fail('Embedding 模型与原记忆不一致，请先统一模型并重建向量');
  const now = Date.now();
  const targetMetadata = metadata(target!);
  const revision = Number(targetMetadata.review_revision || 0) + 1;
  const newId = proposal.action === 'correct_fact' ? target!.memory_id : `reflection_${proposal.id}`;
  const newMetadata = proposal.action === 'correct_fact'
    ? { ...targetMetadata, review_revision: revision, ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }) }
    : { ...(before.current ? metadata(before.current) : {}), kind: 'reflection', event_id: target!.memory_id, status: 'active', review_revision: revision, ...(before.current ? { previous_id: before.current.memory_id } : {}), ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }) };
  const normalized = await svc.normalize({ ...svc.publicMemory(proposal.action === 'correct_fact' ? target! : before.current || target!), memory_id: newId, char_id: charId, content: draft.content, metadata: newMetadata, vector: suppliedVector, model: input.model, dimensions: suppliedVector.length, archived: false, is_summary: false, event_box_id: proposal.action === 'correct_fact' ? target!.event_box_id : null, created_at: proposal.action === 'correct_fact' ? target!.created_at : now, last_accessed_at: proposal.action === 'correct_fact' ? target!.last_accessed_at : now, access_count: proposal.action === 'correct_fact' ? target!.access_count : 0, mood: proposal.action === 'correct_fact' ? (targetMetadata.kind === 'event' ? 'neutral' : target!.mood) : draft.mood || before.current?.mood || 'neutral', pinned_until: proposal.action === 'correct_fact' ? target!.pinned_until : null }, suppliedVector.length);
  // Stage under a fresh vector key. A failed D1 commit never changes the live vector.
  normalized.row.vector_key = await svc.hash('m_', `${newId}:${proposal.id}`);
  await env.VECTORS.upsert([{ id: normalized.row.vector_key, namespace: normalized.row.namespace_key, values: normalized.vector }]);
  const conditions = ["EXISTS(SELECT 1 FROM memory_change_proposals WHERE id=? AND char_id=? AND status='pending')"];
  const values: unknown[] = [proposal.id, charId];
  for (const row of [before.target, before.current].filter((row): row is MemoryRow => !!row)) {
    conditions.push(`EXISTS(SELECT 1 FROM memory_vectors WHERE ${versionFields.map(field => `${String(field)} IS ?`).join(' AND ')})`);
    values.push(...versionFields.map(field => row[field] ?? null));
  }
  const resultIds = [newId];
  const statements = [env.DB.prepare(`INSERT INTO memory_change_guards(proposal_id,valid) VALUES (?, CASE WHEN ${conditions.join(' AND ')} THEN 1 ELSE 0 END)`).bind(proposal.id, ...values), svc.bind(normalized.row)];
  if (proposal.action === 'revise_reflection') {
    statements.push(env.DB.prepare('UPDATE memory_vectors SET metadata_json=? WHERE memory_id=? AND char_id=?').bind(JSON.stringify({ ...targetMetadata, review_revision: revision, current_reflection_id: newId }), target!.memory_id, charId));
    resultIds.push(target!.memory_id);
    if (before.current) {
      statements.push(env.DB.prepare('UPDATE memory_vectors SET metadata_json=?,archived=1 WHERE memory_id=? AND char_id=?').bind(JSON.stringify({ ...metadata(before.current), status: 'superseded', review_revision: revision }), before.current.memory_id, charId));
      resultIds.push(before.current.memory_id);
    }
  }
  statements.push(env.DB.prepare("UPDATE memory_change_proposals SET status='approved',resolved_at=?,result_json=? WHERE id=? AND char_id=? AND status='pending'").bind(now, JSON.stringify(resultIds), proposal.id, charId), env.DB.prepare('DELETE FROM memory_change_guards WHERE proposal_id=?').bind(proposal.id));
  try { await env.DB.batch(statements); } catch (error) {
    const fresh = await env.DB.prepare('SELECT * FROM memory_change_proposals WHERE id=? AND char_id=?').bind(proposal.id, charId).first<ProposalRow>();
    if (fresh?.status === 'approved') return approvedResult(fresh);
    if ((error as Error).message.includes('CHECK constraint')) return fail('原记忆已变化，未保存修改，请重新评估', 409);
    throw error;
  }
  return approvedResult({ ...proposal, result_json: JSON.stringify(resultIds) });
}
