import type { Message } from '../../types';
import { DB } from '../db';
import { safeFetchJson, extractContent } from '../safeApi';
import { checkMemoryChanges, fetchChangeMemories } from './changeClient';
import type { ChangeMemory } from './changeContract';
import type { LightLLMConfig } from './pipeline';
import type { MemoryNode, MemoryRoom, MemoryVector, RemoteVectorConfig } from './types';
import { MemoryNodeDB } from './db';
import { getLatestRecallReceipt } from './recallReceipts';
import { sanitizeQuerySourceMessages } from './querySanitizer';
import { areEventBoxesDisabled } from './eventBoxPolicy';

export async function queueMemoryChangesAfterReply(charId: string, userMessages: Message[], api: LightLLMConfig, sinceTs: number): Promise<number> {
    if (!api.baseUrl || !api.apiKey || !api.model) return 0;
    let cloud: RemoteVectorConfig | undefined;
    try { cloud = JSON.parse(localStorage.getItem('os_remote_vector_config') || 'null') || undefined; } catch { return 0; }
    if (!cloud?.enabled || !cloud.initialized || !await areEventBoxesDisabled(charId, cloud)) return 0;
    const receipt = getLatestRecallReceipt(charId, sinceTs);
    if (!receipt?.ids.length) return 0;
    const recent = await DB.getRecentMessagesByCharId(charId, 30);
    const assistants = recent.filter(message => message.charId === charId && message.role === 'assistant' && message.timestamp >= sinceTs);
    const sources = [...sanitizeQuerySourceMessages(userMessages.filter(message => message.role === 'user')).slice(-4).map(message => ({ role: 'user', content: message.content })), { role: 'assistant', content: sanitizeQuerySourceMessages(assistants).map(message => message.content).join('\n') }];
    const candidates = await fetchChangeMemories(cloud, charId, receipt.ids);
    return checkWithApi(cloud, charId, candidates, sources, api);
}

function checkWithApi(cloud: RemoteVectorConfig, charId: string, candidates: ChangeMemory[], sources: Array<{ role: string; content: string }>, api: LightLLMConfig) {
    return checkMemoryChanges({ cloud, charId, candidates, sources, run: async (system, user) => {
        const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${api.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: api.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, max_tokens: 3500, stream: false }) }, 0, 60_000, { appName: '记忆宫殿', purpose: '待确认记忆建议' });
        return extractContent(data);
    } });
}

const instantCheckKey = (uuid: string) => `memory-change-round:v1:${uuid}`;
/** Preserve the actual request's receipt and user evidence across an instant-chat restart. No API keys. */
export function stageInstantMemoryCheck(charId: string, uuid: string, messages: Message[], sinceTs: number): void {
    const receipt = getLatestRecallReceipt(charId, sinceTs);
    if (!receipt?.ids.length) return;
    const lastAssistant = messages.map(message => message.role).lastIndexOf('assistant');
    const sources = sanitizeQuerySourceMessages(messages.slice(lastAssistant + 1).filter(message => message.role === 'user')).slice(-4).map(message => ({ role: 'user', content: message.content }));
    if (!sources.length) return;
    try {
        // Keep at most 32 requests, so superseded/failed rounds cannot accumulate indefinitely.
        const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => !!key?.startsWith('memory-change-round:v1:'));
        while (keys.length >= 32) localStorage.removeItem(keys.shift()!);
        const cloud = JSON.parse(localStorage.getItem('os_remote_vector_config') || 'null');
        localStorage.setItem(instantCheckKey(uuid), JSON.stringify({ charId, ids: receipt.ids, sources, cloudUrl: cloud?.supabaseUrl, createdAt: Date.now() }));
    } catch { /* Checking is optional; the reply remains durable in the existing outbox. */ }
}

/** Run only after the requested instant round has landed, never at acceptance or during recall. */
export async function checkLandedInstantMemories(charId: string, uuid: string): Promise<number> {
    let job: { charId: string; ids: string[]; sources: Array<{ role: string; content: string }>; cloudUrl: string; createdAt: number };
    let api: LightLLMConfig; let cloud: RemoteVectorConfig;
    try {
        job = JSON.parse(localStorage.getItem(instantCheckKey(uuid)) || 'null');
        cloud = JSON.parse(localStorage.getItem('os_remote_vector_config') || 'null');
        api = JSON.parse(localStorage.getItem('os_memory_palace_config') || 'null')?.lightLLM;
    } catch { return 0; }
    if (!job || job.charId !== charId || !api?.baseUrl || !api.apiKey || !api.model || !cloud?.enabled || !cloud.initialized || cloud.supabaseUrl !== job.cloudUrl || Date.now() - job.createdAt > 7 * 86400_000) return 0;
    if (!await areEventBoxesDisabled(charId, cloud)) return 0;
    const recent = await DB.getRecentMessagesByCharId(charId, 300);
    const assistants = recent.filter(message => message.role === 'assistant' && (message.metadata as any)?.activeMsg2?.taskUuid === uuid);
    if (!assistants.length) return 0;
    const sources = [...job.sources, { role: 'assistant', content: sanitizeQuerySourceMessages(assistants).map(message => message.content).join('\n') }];
    const candidates = await fetchChangeMemories(cloud, charId, job.ids);
    try { return await checkWithApi(cloud, charId, candidates, sources, api); }
    finally { localStorage.removeItem(instantCheckKey(uuid)); }
}

/** Mirror confirmed cloud results without doing another upload or changing unrelated local fields. */
export async function mirrorConfirmedMemoryChanges(records: Array<ChangeMemory & Record<string, unknown>>): Promise<void> {
    const entries: Array<{ node: MemoryNode; vector: MemoryVector }> = [];
    for (const row of records) {
        const vector = typeof row.vector === 'string' ? JSON.parse(row.vector) : row.vector;
        if (!Array.isArray(vector) || vector.length !== row.dimensions || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) throw new Error('云端已确认，但返回向量无效，未覆盖本机记忆');
        const existing = await MemoryNodeDB.getById(row.memory_id);
        if (existing && existing.charId !== row.char_id) throw new Error('本机记忆 ID 与云端角色不符');
        const node: MemoryNode = { ...existing, id: row.memory_id, charId: row.char_id, content: row.content, metadata: row.metadata, room: (row.room || 'living_room') as MemoryRoom, importance: Number(row.importance) || 5, mood: row.mood || 'neutral', tags: Array.isArray(row.tags) ? row.tags as string[] : [], createdAt: Number(row.created_at) || 0, lastAccessedAt: Number(row.last_accessed_at) || 0, accessCount: Number(row.access_count) || 0, archived: row.archived, isBoxSummary: row.is_summary, eventBoxId: typeof row.event_box_id === 'string' ? row.event_box_id : null, pinnedUntil: typeof row.pinned_until === 'number' ? row.pinned_until : null, embedded: true };
        entries.push({ node, vector: { memoryId: node.id, charId: node.charId, vector: Float32Array.from(vector), dimensions: row.dimensions!, model: row.model || '' } });
    }
    await MemoryNodeDB.saveVectorizedMany(entries);
}
