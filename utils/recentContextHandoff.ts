export type HandoffMessageRole = 'user' | 'assistant' | 'system';
export type HandoffMessageOrigin = 'main' | 'lite';

export interface HandoffMessage {
  id: string;
  role: HandoffMessageRole;
  content: string;
  createdAt: number;
  origin: HandoffMessageOrigin;
  handoffKind?: 'upload' | 'receive';
  handoffLabel?: string;
  handoffSummary?: string;
}

export interface SharedRecentContext {
  brainId: 'primary';
  charId: string;
  messages: HandoffMessage[];
  sourceDeviceId: string;
  sourceDeviceName: string;
  revision: number;
  updatedAt: number;
  prompt?: string;
}

export interface HandoffCloudConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  deviceId: string;
  deviceName: string;
}

export const SHARED_CONTEXT_LIMIT = 30;
export const HANDOFF_BRAIN_ID = 'primary' as const;

export const SHARED_CONTEXT_SQL = `-- Sully 跨设备接力（个人 Supabase 项目）
create table if not exists shared_recent_contexts (
  brain_id text primary key default 'primary',
  char_id text not null default '',
  messages jsonb not null default '[]'::jsonb,
  source_device_id text not null default '',
  source_device_name text not null default '',
  revision bigint not null default 1,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- 兼容已经运行过旧版初始化 SQL 的数据库
alter table shared_recent_contexts add column if not exists char_id text not null default '';
alter table shared_recent_contexts add column if not exists source_device_id text not null default '';
alter table shared_recent_contexts add column if not exists source_device_name text not null default '';

alter table shared_recent_contexts enable row level security;
drop policy if exists "Allow personal context access" on shared_recent_contexts;
create policy "Allow personal context access" on shared_recent_contexts
  for all using (true) with check (true);`;

export function isHandoffMessage(value: unknown): value is HandoffMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string'
    && (item.role === 'user' || item.role === 'assistant' || item.role === 'system')
    && typeof item.content === 'string'
    && typeof item.createdAt === 'number'
    && Number.isFinite(item.createdAt)
    && item.createdAt > 0;
}

export function normalizeHandoffMessages(value: unknown): HandoffMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isHandoffMessage).map((message) => ({
    ...message,
    content: message.content.trim(),
    origin: message.origin === 'main' ? 'main' as const : 'lite' as const,
  })).filter((message) => message.content.length > 0);
}

export function mergeHandoffMessages(
  sharedMessages: HandoffMessage[],
  localMessages: HandoffMessage[],
  limit: number = SHARED_CONTEXT_LIMIT,
): HandoffMessage[] {
  const byId = new Map<string, HandoffMessage>();
  for (const message of [...sharedMessages, ...localMessages]) {
    if (!isHandoffMessage(message) || !message.content.trim()) continue;
    byId.set(message.id, {
      ...message,
      content: message.content.trim(),
      origin: message.origin === 'main' ? 'main' : 'lite',
    });
  }
  return [...byId.values()]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .slice(-Math.max(1, limit));
}

export function parseSharedContextRow(row: Record<string, unknown>): SharedRecentContext {
  const records = normalizeHandoffMessages(row.messages);
  const cookieSummary = records.find(m => m.id === 'cookie:handoff-summary:v1');
  return {
    brainId: HANDOFF_BRAIN_ID,
    charId: String(row.char_id || ''),
    messages: records.filter(m => m.id !== 'cookie:handoff-summary:v1'),
    sourceDeviceId: String(row.source_device_id || ''),
    sourceDeviceName: String(row.source_device_name || row.source_device || ''),
    revision: Number(row.revision) || 1,
    updatedAt: Number(row.updated_at) || 0,
    prompt: String(records.find(m => m.handoffKind === 'upload')?.handoffSummary || cookieSummary?.content || row.prompt || ''),
  };
}

export function newHandoffMessage(role: HandoffMessageRole, content: string): HandoffMessage {
  return {
    id: `lite:${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
    role,
    content: content.trim(),
    createdAt: Date.now(),
    origin: 'lite',
  };
}

export function buildReceivedHandoff(context: SharedRecentContext, config: HandoffCloudConfig): HandoffMessage {
  const source = context.sourceDeviceName || '未命名设备';
  const destination = config.deviceName.trim() || '未命名设备';
  const label = `以下消息接收自 ${source} · 接收于 ${destination}`;
  return {
    id: `received:${context.sourceDeviceId}:${context.updatedAt}:${context.revision}`,
    role: 'system', origin: 'lite', createdAt: Math.max(1, (context.messages.find(m => m.role !== 'system')?.createdAt || context.updatedAt) - 1),
    content: [label, context.prompt?.trim(), `现在已迁移至 ${destination} 继续对话。`].filter(Boolean).join('\n'),
    handoffKind: 'receive', handoffLabel: label,
  };
}

export function receiveHandoffMessages(context: SharedRecentContext, config: HandoffCloudConfig, local: HandoffMessage[]): HandoffMessage[] {
  if (context.sourceDeviceId === config.deviceId) return local;
  const marker = buildReceivedHandoff(context, config);
  if (local.some(m => m.id === marker.id)) return local;
  return mergeHandoffMessages([], [marker, ...context.messages.filter(m => m.role !== 'system'), ...local], 100);
}

export function handoffSummaryInstructions(at = new Date(), characterName = '角色'): string {
  // Callers with character time zones pass the character's wall clock.
  const time = `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日${at.getHours()}时${at.getMinutes()}分`;
  return `请以角色「${characterName}」的第一人称写一段简短的跨设备迁移总结，约80–150字，不虚构事实。“我”始终指角色本人，不是用户；assistant 消息是你说的话，user 消息是对方说的话，不要把对方的活动、感受或经历写成自己的。以“现在是${time}，我刚才在”开头，说明你刚才在做什么、与对方聊到哪里及尚未完成的事，以“接下来我要迁移到另一台设备继续对话。”结尾。只输出角色的总结正文，不写分析。这是临时接力上下文，不是长期记忆。`;
}

export async function generateHandoffSummary(api: { baseUrl: string; apiKey: string; model: string }, messages: Array<{ role: string; content: unknown }>): Promise<string> {
  if (!api.baseUrl.trim() || !api.model.trim()) throw new Error('请先填写聊天 API 地址和模型');
  const base = api.baseUrl.trim().replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(base.endsWith('/chat/completions') ? base : `${base}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(api.apiKey ? { Authorization: `Bearer ${api.apiKey.trim()}` } : {}) },
      body: JSON.stringify({ model: api.model, stream: false, messages }),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `生成迁移总结失败（${response.status}）`);
    const raw = data?.choices?.[0]?.message?.content;
    const text = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(p => p.text || '').join('') : '').replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '').trim();
    if (!text) throw new Error('API 没有返回迁移总结，请重试');
    return text;
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('生成迁移总结超过两分钟，请重试');
    throw error;
  } finally { clearTimeout(timeout); }
}

function normalizedConfig(config: HandoffCloudConfig): HandoffCloudConfig {
  return {
    ...config,
    supabaseUrl: config.supabaseUrl.trim().replace(/\/+$/, ''),
    supabaseAnonKey: config.supabaseAnonKey.trim(),
    deviceId: config.deviceId.trim(),
    deviceName: config.deviceName.trim(),
  };
}

function ensureConfig(config: HandoffCloudConfig): HandoffCloudConfig {
  const clean = normalizedConfig(config);
  if (!clean.supabaseUrl || !clean.supabaseAnonKey) throw new Error('请先填写同步服务 URL 和访问密钥');
  if (!clean.deviceId) throw new Error('当前设备缺少设备 ID，请刷新页面后重试');
  return clean;
}

function headers(config: HandoffCloudConfig, prefer?: string): Record<string, string> {
  return {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${config.supabaseAnonKey}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

function tableUrl(config: HandoffCloudConfig, query: string): string {
  return `${config.supabaseUrl}/rest/v1/shared_recent_contexts${query}`;
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  if (response.status === 404 || body.includes('shared_recent_contexts') || body.includes('char_id')) {
    return '云端接力存储尚未初始化或需要升级';
  }
  if (response.status === 401 || response.status === 403) return '云端认证失败，请检查同步服务 URL 和访问密钥';
  return body ? `云端返回 ${response.status}：${body.slice(0, 180)}` : `云端返回 HTTP ${response.status}`;
}

export async function fetchSharedContext(config: HandoffCloudConfig): Promise<SharedRecentContext | null> {
  const clean = ensureConfig(config);
  const query = '?select=*&brain_id=eq.primary&limit=1';
  const response = await fetch(tableUrl(clean, query), { headers: headers(clean) });
  if (!response.ok) throw new Error(await readError(response));
  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? parseSharedContextRow(rows[0]) : null;
}

export async function testSharedContextConnection(config: HandoffCloudConfig): Promise<string> {
  const context = await fetchSharedContext(config);
  return context ? `连接成功，已发布来自 ${context.sourceDeviceName || '未命名设备'}` : '连接成功，目前还没有同步过上下文';
}

/** Vector synchronization must never republish or strip a user's handoff summary. */
export async function initializeHandoffCharacter(config: HandoffCloudConfig, charId: string): Promise<SharedRecentContext> {
  const existing = await fetchSharedContext(config);
  if (existing) return existing;
  return publishSharedContext({ config, charId, sharedMessages: [], localMessages: [], allowEmptyMessages: true });
}

export async function publishSharedContext(input: {
  config: HandoffCloudConfig;
  charId: string;
  sharedMessages: HandoffMessage[];
  localMessages: HandoffMessage[];
  previousRevision?: number;
  allowEmptyMessages?: boolean;
  summary?: string;
}): Promise<SharedRecentContext> {
  const clean = ensureConfig(input.config);
  const charId = input.charId.trim();
  if (!charId) throw new Error('缺少原版角色 ID，请先在原版聊天页发布一次近期上下文');
  const messages = mergeHandoffMessages(input.sharedMessages, input.localMessages).filter(m => m.role !== 'system');
  if (messages.length === 0 && !input.allowEmptyMessages) throw new Error('当前没有可以同步的聊天内容');
  // Carry the handoff envelope inside JSON messages so existing Supabase and
  // Worker stores retain it without a schema migration. Reserve one of 30 slots.
  if (input.summary?.trim()) {
    messages.splice(0, Math.max(0, messages.length - (SHARED_CONTEXT_LIMIT - 1)));
    messages.push({
      id: `handoff:${clean.deviceId}:${Date.now()}`, role: 'system',
      content: `上传于 ${clean.deviceName || '未命名设备'}`, createdAt: Date.now(), origin: 'lite',
      handoffKind: 'upload', handoffLabel: `上传于 ${clean.deviceName || '未命名设备'}`,
      handoffSummary: input.summary.trim(),
    });
  }
  const payload = {
    brain_id: HANDOFF_BRAIN_ID,
    char_id: charId,
    messages,
    source_device_id: clean.deviceId,
    source_device_name: clean.deviceName || '未命名设备',
    revision: Math.max(0, input.previousRevision || 0) + 1,
    updated_at: Date.now(),
  };
  const response = await fetch(tableUrl(clean, '?on_conflict=brain_id'), {
    method: 'POST',
    headers: headers(clean, 'resolution=merge-duplicates,missing=default,return=representation'),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await readError(response));
  const rows = await response.json();
  return parseSharedContextRow(Array.isArray(rows) && rows[0] ? rows[0] : payload);
}

export async function clearSharedContext(config: HandoffCloudConfig): Promise<void> {
  const clean = ensureConfig(config);
  const response = await fetch(tableUrl(clean, '?brain_id=eq.primary'), {
    method: 'DELETE',
    headers: headers(clean, 'return=minimal'),
  });
  if (!response.ok) throw new Error(await readError(response));
}
