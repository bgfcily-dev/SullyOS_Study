import type { LiteCloudConfig, LiteMemoryRecall } from './types';
import { readMemoryMetadata } from '../utils/memoryPalace/metadata';
import { resolveCurrentMemoryState } from '../utils/memoryPalace/currentState';
export { asksIdentityHistory, formatMemoryContext } from '../utils/memoryPalace/currentState';


/** Resolve explicit links, never guess the current reflection from similarity or date. */
export async function resolveMemoryState(candidates: LiteMemoryRecall[], cloud: LiteCloudConfig, charId: string, includeIdentity = false): Promise<LiteMemoryRecall[]> {
  const records = new Map(candidates.map((item) => [item.memoryId, item]));
  const load = async (id: string) => {
    if (!id || id.length > 300) return undefined;
    // Re-read linked records so an old cached candidate cannot validate an outdated pointer.
    const params = new URLSearchParams({ select: 'memory_id,char_id,content,room,importance,metadata,archived,is_summary', char_id: `eq.${charId}`, memory_id: `eq.${id}`, limit: '1' });
    const response = await fetch(`${cloud.supabaseUrl.replace(/\/+$/, '')}/rest/v1/memory_vectors?${params}`, {
      headers: { apikey: cloud.supabaseAnonKey, Authorization: `Bearer ${cloud.supabaseAnonKey}` },
    });
    if (!response.ok) throw new Error('无法核对记忆当前状态，请稍后重试');
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows.find((value) => value.memory_id === id && value.char_id === charId && !value.archived && !value.is_summary) : undefined;
    if (!row || typeof row.content !== 'string') { records.delete(id); return undefined; }
    const item: LiteMemoryRecall = { memoryId: id, content: row.content, room: row.room || '', importance: Number(row.importance) || 5, similarity: records.get(id)?.similarity || 0, metadata: readMemoryMetadata(row.metadata) };
    records.set(id, item); return item;
  };
  return resolveCurrentMemoryState(candidates, load, includeIdentity);
}
