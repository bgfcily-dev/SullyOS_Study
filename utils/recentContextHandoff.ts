export type HandoffMessageRole = 'user' | 'assistant';
export type HandoffMessageOrigin = 'main' | 'lite';

export interface HandoffMessage {
  id: string;
  role: HandoffMessageRole;
  content: string;
  createdAt: number;
  origin: HandoffMessageOrigin;
}

export interface SharedRecentContext {
  brainId: 'primary';
  charId: string;
  messages: HandoffMessage[];
  sourceDeviceId: string;
  sourceDeviceName: string;
  revision: number;
  updatedAt: number;
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
    && (item.role === 'user' || item.role === 'assistant')
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
  return {
    brainId: HANDOFF_BRAIN_ID,
    charId: String(row.char_id || ''),
    messages: normalizeHandoffMessages(row.messages),
    sourceDeviceId: String(row.source_device_id || ''),
    sourceDeviceName: String(row.source_device_name || row.source_device || ''),
    revision: Number(row.revision) || 1,
    updatedAt: Number(row.updated_at) || 0,
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
  if (!clean.supabaseUrl || !clean.supabaseAnonKey) throw new Error('请先填写 Supabase URL 和 Publishable / anon key');
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
    return '云端接力表尚未初始化或需要升级，请在轻量版设置中复制并运行最新初始化 SQL';
  }
  if (response.status === 401 || response.status === 403) return 'Supabase 认证失败，请检查 URL 和 Publishable / anon key';
  return body ? `云端返回 ${response.status}：${body.slice(0, 180)}` : `云端返回 HTTP ${response.status}`;
}

export async function fetchSharedContext(config: HandoffCloudConfig): Promise<SharedRecentContext | null> {
  const clean = ensureConfig(config);
  const query = '?select=brain_id,char_id,messages,source_device_id,source_device_name,revision,updated_at&brain_id=eq.primary&limit=1';
  const response = await fetch(tableUrl(clean, query), { headers: headers(clean) });
  if (!response.ok) throw new Error(await readError(response));
  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? parseSharedContextRow(rows[0]) : null;
}

export async function testSharedContextConnection(config: HandoffCloudConfig): Promise<string> {
  const context = await fetchSharedContext(config);
  return context ? `连接成功，已找到第 ${context.revision} 版共享上下文` : '连接成功，目前还没有同步过上下文';
}

export async function publishSharedContext(input: {
  config: HandoffCloudConfig;
  charId: string;
  sharedMessages: HandoffMessage[];
  localMessages: HandoffMessage[];
  previousRevision?: number;
}): Promise<SharedRecentContext> {
  const clean = ensureConfig(input.config);
  const charId = input.charId.trim();
  if (!charId) throw new Error('缺少原版角色 ID，请先在原版聊天页发布一次近期上下文');
  const messages = mergeHandoffMessages(input.sharedMessages, input.localMessages);
  if (messages.length === 0) throw new Error('当前没有可以同步的聊天内容');
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
