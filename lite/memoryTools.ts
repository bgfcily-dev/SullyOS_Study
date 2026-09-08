import { getEmbedding, getEmbeddings } from '../utils/memoryPalace/embedding';
import { getVectorCount, testConnection, upsertVector, upsertVectorBatch } from '../utils/memoryPalace/supabaseVector';
import type { MemoryNode, MemoryRoom, RemoteVectorConfig } from '../utils/memoryPalace/types';
import { extractLiteText, liteChatUrl } from './chatApi';
import { buildLiteRoleContext, LITE_MEMORY_EXTRACTION_RULES } from './prompts';
import type { LiteApiProfile, LiteCloudConfig, LiteEmbeddingConfig, LiteIdentity, LiteMemoryDraft, LiteMessage, LiteSyncedMemory, LiteVectorStats, PreparedLiteMemoryBatch } from './types';

const VALID_ROOMS = new Set<MemoryRoom>([
  'living_room', 'bedroom', 'study', 'user_room', 'self_room', 'attic', 'windowsill',
]);

const remoteConfig = (cloud: LiteCloudConfig): RemoteVectorConfig => ({
  enabled: true,
  initialized: true,
  supabaseUrl: cloud.supabaseUrl.trim(),
  supabaseAnonKey: cloud.supabaseAnonKey.trim(),
});

const ensureCloud = (cloud: LiteCloudConfig): void => {
  if (!cloud.supabaseUrl.trim() || !cloud.supabaseAnonKey.trim()) {
    throw new Error('请先填写 Supabase URL 和 Publishable / anon key');
  }
};

const cloudHeaders = (cloud: LiteCloudConfig): Record<string, string> => ({
  apikey: cloud.supabaseAnonKey.trim(),
  Authorization: `Bearer ${cloud.supabaseAnonKey.trim()}`,
  'Content-Type': 'application/json',
});

const memoryRestUrl = (cloud: LiteCloudConfig, query: URLSearchParams): string =>
  `${cloud.supabaseUrl.trim().replace(/\/+$/, '')}/rest/v1/memory_vectors?${query.toString()}`;

const finiteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function parseLiteSyncedMemoryRows(value: unknown): LiteSyncedMemory[] {
  if (!Array.isArray(value)) return [];
  const memories: LiteSyncedMemory[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const memoryId = typeof row.memory_id === 'string' ? row.memory_id.trim() : '';
    const charId = typeof row.char_id === 'string' ? row.char_id.trim() : '';
    const content = typeof row.content === 'string' ? row.content.trim() : '';
    if (!memoryId.startsWith('lite_ctx_') || !charId || !content) continue;
    memories.push({
      memoryId,
      charId,
      content,
      room: VALID_ROOMS.has(row.room as MemoryRoom) ? row.room as MemoryRoom : 'living_room',
      importance: Math.max(1, Math.min(10, Math.round(finiteNumber(row.importance, 5)))),
      mood: typeof row.mood === 'string' ? row.mood : '',
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      createdAt: finiteNumber(row.created_at),
      lastAccessedAt: finiteNumber(row.last_accessed_at),
      accessCount: Math.max(0, Math.round(finiteNumber(row.access_count))),
      model: typeof row.model === 'string' ? row.model : '',
      dimensions: Math.max(0, Math.round(finiteNumber(row.dimensions))),
      archived: row.archived === true,
    });
  }
  return memories;
}

export async function fetchLiteSyncedMemories(cloud: LiteCloudConfig, charId: string): Promise<LiteSyncedMemory[]> {
  ensureCloud(cloud);
  const cleanCharId = charId.trim();
  if (!cleanCharId) throw new Error('尚未获取原版角色 ID，请先在原版同步一次近期上下文');
  const pageSize = 500;
  const memories: LiteSyncedMemory[] = [];
  for (let offset = 0; offset < 5000; offset += pageSize) {
    const query = new URLSearchParams({
      select: 'memory_id,char_id,content,dimensions,model,room,importance,tags,mood,created_at,last_accessed_at,access_count,archived',
      char_id: `eq.${cleanCharId}`,
      memory_id: 'like.lite_ctx_*',
      order: 'created_at.desc',
      limit: String(pageSize),
      offset: String(offset),
    });
    let response: Response;
    try {
      response = await fetch(memoryRestUrl(cloud, query), { headers: cloudHeaders(cloud) });
    } catch {
      throw new Error('无法连接 Supabase，请检查网络、URL 和浏览器跨域设置');
    }
    const raw = await response.text();
    if (!response.ok) throw new Error(`读取已同步记忆失败（${response.status}）：${raw.slice(0, 180) || '未知错误'}`);
    let rows: unknown;
    try { rows = raw ? JSON.parse(raw) : []; } catch { throw new Error('Supabase 返回了无法识别的数据'); }
    const page = parseLiteSyncedMemoryRows(rows);
    memories.push(...page);
    if (!Array.isArray(rows) || rows.length < pageSize) break;
  }
  return memories;
}

export async function updateLiteSyncedMemory(input: {
  memory: LiteSyncedMemory;
  draft: Pick<LiteSyncedMemory, 'content' | 'room' | 'importance' | 'mood' | 'tags'>;
  cloud: LiteCloudConfig;
  embedding: LiteEmbeddingConfig;
}): Promise<LiteSyncedMemory> {
  const { memory, cloud, embedding } = input;
  ensureCloud(cloud);
  if (!memory.memoryId.startsWith('lite_ctx_')) throw new Error('只能修改由 Lite 上传的记忆');
  const content = input.draft.content.trim().slice(0, 4000);
  if (!content) throw new Error('记忆内容不能为空');
  const next: LiteSyncedMemory = {
    ...memory,
    content,
    room: VALID_ROOMS.has(input.draft.room as MemoryRoom) ? input.draft.room : 'living_room',
    importance: Math.max(1, Math.min(10, Math.round(Number(input.draft.importance) || 5))),
    mood: input.draft.mood.trim().slice(0, 40),
    tags: input.draft.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
  };

  if (next.content !== memory.content) {
    if (!embedding.baseUrl.trim() || !embedding.apiKey.trim() || !embedding.model.trim()) {
      throw new Error('修改正文需要先填写完整的 Embedding API，程序要为新正文重新生成向量');
    }
    const vector = await getEmbedding(next.content, embedding);
    if (vector.length !== embedding.dimensions) {
      throw new Error(`模型返回 ${vector.length} 维，当前设置为 ${embedding.dimensions} 维，未保存修改`);
    }
    const node: MemoryNode = {
      id: next.memoryId,
      charId: next.charId,
      content: next.content,
      room: next.room,
      tags: next.tags,
      importance: next.importance,
      mood: next.mood,
      embedded: true,
      createdAt: next.createdAt,
      lastAccessedAt: next.lastAccessedAt || next.createdAt,
      accessCount: next.accessCount,
      pinnedUntil: null,
      origin: 'extraction',
      archived: next.archived,
      isBoxSummary: false,
      eventBoxId: null,
    };
    const saved = await upsertVector(remoteConfig(cloud), next.memoryId, next.charId, vector, node, embedding.dimensions, embedding.model);
    if (!saved) throw new Error('新向量已生成，但 Supabase 没有保存修改');
    return { ...next, model: embedding.model, dimensions: embedding.dimensions };
  }

  const query = new URLSearchParams({ select: 'memory_id', memory_id: `eq.${next.memoryId}`, char_id: `eq.${next.charId}` });
  let response: Response;
  try {
    response = await fetch(memoryRestUrl(cloud, query), {
      method: 'PATCH',
      headers: { ...cloudHeaders(cloud), Prefer: 'return=representation' },
      body: JSON.stringify({ room: next.room, importance: next.importance, mood: next.mood, tags: next.tags }),
    });
  } catch {
    throw new Error('无法连接 Supabase，修改没有保存');
  }
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Supabase 修改失败（${response.status}）：${responseText.slice(0, 160)}`);
  try {
    const rows = JSON.parse(responseText);
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('not-found');
  } catch {
    throw new Error('云端没有找到这条记忆，可能已在另一台设备删除，请刷新列表');
  }
  return next;
}

export async function deleteLiteSyncedMemory(cloud: LiteCloudConfig, memory: LiteSyncedMemory): Promise<void> {
  ensureCloud(cloud);
  if (!memory.memoryId.startsWith('lite_ctx_')) throw new Error('只能删除由 Lite 上传的记忆');
  const query = new URLSearchParams({ select: 'memory_id', memory_id: `eq.${memory.memoryId}`, char_id: `eq.${memory.charId}` });
  let response: Response;
  try {
    response = await fetch(memoryRestUrl(cloud, query), { method: 'DELETE', headers: { ...cloudHeaders(cloud), Prefer: 'return=representation' } });
  } catch {
    throw new Error('无法连接 Supabase，记忆没有删除');
  }
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Supabase 删除失败（${response.status}）：${responseText.slice(0, 160)}`);
  try {
    const rows = JSON.parse(responseText);
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('not-found');
  } catch {
    throw new Error('云端没有找到这条记忆，可能已在另一台设备删除，请刷新列表');
  }
}

export function parseLiteMemoryDrafts(raw: string): LiteMemoryDraft[] {
  const clean = raw
    .replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('记忆整理结果不是有效的 JSON 数组');
  let parsed: unknown;
  try { parsed = JSON.parse(clean.slice(start, end + 1)); } catch {
    throw new Error('记忆整理结果的 JSON 格式有误，请重试');
  }
  if (!Array.isArray(parsed)) throw new Error('记忆整理结果不是数组');
  const drafts: LiteMemoryDraft[] = [];
  for (const value of parsed.slice(0, 8)) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const content = typeof item.content === 'string' ? item.content.trim().slice(0, 2000) : '';
    if (!content) continue;
    const room = VALID_ROOMS.has(item.room as MemoryRoom) ? item.room as MemoryRoom : 'living_room';
    const importance = Math.max(1, Math.min(10, Math.round(Number(item.importance) || 5)));
    const mood = typeof item.mood === 'string' ? item.mood.trim().slice(0, 40) || 'neutral' : 'neutral';
    const tags = Array.isArray(item.tags)
      ? item.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean).slice(0, 5)
      : [];
    drafts.push({ content, room, importance, mood, tags });
  }
  return drafts;
}

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export async function inspectLiteVectorStore(cloud: LiteCloudConfig, charId: string): Promise<LiteVectorStats> {
  ensureCloud(cloud);
  const config = remoteConfig(cloud);
  const connection = await testConnection(config);
  if (!connection.ok || !connection.tableExists) throw new Error(connection.message);
  const cleanCharId = charId.trim();
  const [totalCount, currentCharacterCount] = await Promise.all([
    getVectorCount(config),
    cleanCharId ? getVectorCount(config, cleanCharId) : Promise.resolve(null),
  ]);
  return { totalCount, currentCharacterCount, charId: cleanCharId, checkedAt: Date.now() };
}

export async function testLiteEmbeddingConnection(config: LiteEmbeddingConfig): Promise<string> {
  if (!config.baseUrl.trim() || !config.apiKey.trim() || !config.model.trim()) {
    throw new Error('请先填写完整的 Embedding API 地址、密钥和模型');
  }
  const vector = await getEmbedding('连接测试', config);
  if (vector.length !== config.dimensions) {
    throw new Error(`连接成功，但模型返回 ${vector.length} 维，当前设置为 ${config.dimensions} 维`);
  }
  return `连接成功：${config.model} 返回 ${vector.length} 维向量`;
}

export async function prepareLiteContextMemories(input: {
  api: LiteApiProfile;
  identity: LiteIdentity;
  charId: string;
  messages: LiteMessage[];
  extractionPrompt?: string;
}): Promise<PreparedLiteMemoryBatch> {
  const { api, identity } = input;
  const charId = input.charId.trim();
  if (!charId) throw new Error('尚未获取原版角色 ID，请先在原版同步一次近期上下文');
  if (!api.baseUrl.trim() || !api.apiKey.trim() || !api.model.trim()) {
    throw new Error('请先完成用于整理记忆的语言模型 API 配置');
  }
  const messages = input.messages.slice(-50);
  if (messages.length < 2) throw new Error('当前上下文太少，至少需要 2 条消息');
  const conversation = messages.map((message) => {
    const speaker = message.role === 'user' ? identity.userName || '用户' : identity.characterName || '角色';
    return `[${speaker}] ${message.content.slice(0, 1200)}`;
  }).join('\n');
  const customPrompt = input.extractionPrompt?.trim();
  const systemPrompt = `${buildLiteRoleContext(identity)}

${LITE_MEMORY_EXTRACTION_RULES}
请用角色第一人称“我”记录，对用户直接用用户名称呼。
一个话题通常提取 1–5 条，琐碎内容不必记录，最多 8 条。
房间只能是：living_room（日常）、bedroom（亲密关系）、study（工作学习）、user_room（用户资料与人际）、self_room（角色自我）、attic（未解决困惑伤害）、windowsill（期盼与目标）。
${customPrompt ? `用户补充的整理要求：\n${customPrompt}` : ''}
只输出 JSON 数组，不要 Markdown：
[{"content":"记忆正文","room":"living_room","importance":5,"mood":"neutral","tags":["标签"]}]`;

  let response: Response;
  try {
    response = await fetch(liteChatUrl(api.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey.trim()}` },
      body: JSON.stringify({
        model: api.model.trim(),
        stream: false,
        temperature: 0.3,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: conversation }],
      }),
    });
  } catch {
    throw new Error('无法连接聊天 API，记忆整理未开始');
  }
  const raw = await response.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* handled below */ }
  if (!response.ok) {
    const detail = extractLiteText(data?.error?.message ?? data?.error) || raw.slice(0, 160);
    throw new Error(`记忆整理 API 失败（${response.status}）：${detail || '未知错误'}`);
  }
  const reply = extractLiteText(data?.choices?.[0]?.message?.content);
  const drafts = parseLiteMemoryDrafts(reply);
  const createdAt = messages[messages.length - 1]?.createdAt || Date.now();
  const contextSignature = messages.map((message) => message.id).join('|');
  return { memories: drafts, charId, contextSignature, createdAt, usedMessages: messages.length };
}

export async function uploadPreparedLiteMemories(input: {
  batch: PreparedLiteMemoryBatch;
  cloud: LiteCloudConfig;
  embedding: LiteEmbeddingConfig;
}): Promise<{ saved: number }> {
  const { batch, cloud, embedding } = input;
  ensureCloud(cloud);
  if (!embedding.baseUrl.trim() || !embedding.apiKey.trim() || !embedding.model.trim()) {
    throw new Error('请先完成 Embedding API 配置，它负责生成向量');
  }
  if (batch.memories.length === 0) return { saved: 0 };

  const vectors = await getEmbeddings(batch.memories.map((draft) => draft.content), embedding);
  if (vectors.length !== batch.memories.length || vectors.some((vector) => vector.length !== embedding.dimensions)) {
    throw new Error('生成的向量数量或维度与当前设置不一致');
  }
  const items = batch.memories.map((draft, index) => {
    const memoryId = `lite_ctx_${stableHash(`${batch.charId}|${batch.contextSignature}|${draft.room}|${draft.content}`)}_${index}`;
    const node: MemoryNode = {
      id: memoryId,
      charId: batch.charId,
      content: draft.content,
      room: draft.room,
      tags: draft.tags,
      importance: draft.importance,
      mood: draft.mood,
      embedded: true,
      createdAt: batch.createdAt,
      lastAccessedAt: batch.createdAt,
      accessCount: 0,
      pinnedUntil: null,
      origin: 'extraction',
      archived: false,
      isBoxSummary: false,
      eventBoxId: null,
    };
    return { memoryId, charId: batch.charId, vector: vectors[index], node, dimensions: embedding.dimensions, model: embedding.model };
  });
  const saved = await upsertVectorBatch(remoteConfig(cloud), items);
  if (!saved) throw new Error('向量已生成，但写入 Supabase memory_vectors 失败');
  return { saved: items.length };
}
