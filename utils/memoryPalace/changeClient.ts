import { MEMORY_CHANGE_RULES, stableJson, validateChangeDraft, type ChangeMemory, type MemoryChangeDraft, type MemoryChangeProposal } from './changeContract';

export interface ChangeCloud { supabaseUrl: string; supabaseAnonKey: string }
import { isReviewedMemoryBackend } from './remoteBackend';
export const MEMORY_CHANGES_UPDATED = 'memory-change-proposals-updated';
export const supportsMemoryChanges = (cloud: ChangeCloud) => {
    try { return (new URL(cloud.supabaseUrl).hostname.endsWith('.workers.dev') || isReviewedMemoryBackend(cloud.supabaseUrl)) && !!cloud.supabaseAnonKey.trim(); } catch { return false; }
};
async function call(cloud: ChangeCloud, path: string, body?: unknown) {
    if (!supportsMemoryChanges(cloud)) throw new Error('确认更新需要使用已升级的 CF 记忆服务');
    const response = await fetch(`${cloud.supabaseUrl.replace(/\/+$/, '')}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { apikey: cloud.supabaseAnonKey, Authorization: `Bearer ${cloud.supabaseAnonKey}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(result.error || `记忆建议请求失败（${response.status}）`);
    return result;
}
export async function fetchMemoryChanges(cloud: ChangeCloud, charId: string, offset = 0): Promise<{ proposals: MemoryChangeProposal[]; total: number }> {
    if (!supportsMemoryChanges(cloud) || !charId) return { proposals: [], total: 0 };
    const result = await call(cloud, `/memory/change-proposals?${new URLSearchParams({ char_id: charId, offset: String(offset) })}`);
    if (!Array.isArray(result.proposals) || !Number.isInteger(result.total) || result.total < 0) throw new Error('云端记忆建议响应无效，请更新记忆服务');
    return result;
}
export async function fetchChangeMemories(cloud: ChangeCloud, charId: string, ids: string[]): Promise<ChangeMemory[]> {
    const safeIds = [...new Set(ids)].filter(id => id.length <= 300 && !/[(),]/.test(id)).slice(0, 24);
    if (!safeIds.length) return [];
    return call(cloud, `/rest/v1/memory_vectors?${new URLSearchParams({ char_id: `eq.${charId}`, memory_id: `in.(${safeIds.join(',')})`, select: 'memory_id,char_id,content,metadata,archived,is_summary,room,importance,mood,model,dimensions', limit: '24' })}`);
}
function announce(charId: string) { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(MEMORY_CHANGES_UPDATED, { detail: { charId } })); }
export async function submitMemoryChange(cloud: ChangeCloud, charId: string, target: ChangeMemory, draft: MemoryChangeDraft, sources: Array<{ role: string; content: string }>): Promise<MemoryChangeProposal> {
    const result = await call(cloud, '/memory/change-proposals', { ...draft, char_id: charId, base: { content: target.content, metadata: target.metadata || {} }, sources });
    announce(charId); return result;
}
export async function decideMemoryChange(input: { cloud: ChangeCloud; proposal: MemoryChangeProposal; approve: boolean; embed?: (text: string) => Promise<number[]>; model?: string }): Promise<{ status: string; records?: Array<ChangeMemory & Record<string, unknown>> }> {
    const { cloud, proposal, approve } = input;
    const body: Record<string, unknown> = { char_id: proposal.char_id };
    if (approve) {
        if (!input.embed || !input.model) throw new Error('确认修改前请填写完整的 Embedding API');
        body.confirmed = true;
        body.vector = await input.embed(proposal.content);
        body.model = input.model;
    }
    const result = await call(cloud, `/memory/change-proposals/${encodeURIComponent(proposal.id)}/${approve ? 'approve' : 'reject'}`, body);
    announce(proposal.char_id); return result;
}

const runningChecks = new Map<string, Promise<number>>();
async function fingerprint(value: unknown) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Called only after a new successful conversation, never by retrieval or browsing. */
export async function checkMemoryChanges(input: { cloud: ChangeCloud; charId: string; candidates: ChangeMemory[]; sources: Array<{ role: string; content: string }>; run: (system: string, user: string) => Promise<string> }): Promise<number> {
    if (!supportsMemoryChanges(input.cloud)) return 0;
    const candidates = input.candidates.filter(item => item.char_id === input.charId && !item.archived && !item.is_summary && item.content.length <= 6000 && (!item.metadata?.status || item.metadata.status === 'active') && (!item.metadata?.kind || item.metadata.kind === 'event')).slice(0, 6);
    const sources = input.sources.filter(source => ['user', 'assistant'].includes(source.role) && source.content.trim()).slice(-6);
    if (!candidates.length || !sources.some(source => source.role === 'user') || sources.some(source => source.content.length > 12000)) return 0;
    const key = await fingerprint([input.cloud.supabaseUrl, input.cloud.supabaseAnonKey, input.charId, candidates.map(item => [item.memory_id, item.content, item.metadata]), sources]);
    const storageKey = 'memory-change-checks:v1';
    const readChecked = (): string[] => { try { const values = JSON.parse(localStorage.getItem(storageKey) || '[]'); return Array.isArray(values) ? values.filter(value => typeof value === 'string') : []; } catch { return []; } };
    if (readChecked().includes(key)) return 0;
    const running = runningChecks.get(key); if (running) return running;
    const job = (async () => {
        const oldRecords = candidates.map(target => ({ ...target, current_reflection: input.candidates.find(item => item.memory_id === target.metadata?.current_reflection_id && item.metadata?.kind === 'reflection' && item.metadata.event_id === target.memory_id && !item.archived) || null }));
        const text = await input.run(MEMORY_CHANGE_RULES, JSON.stringify({ existing_memories: oldRecords, new_conversation: sources }));
        const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as unknown;
        if (!Array.isArray(parsed) || parsed.length > 3) throw new Error('记忆建议返回格式无效');
        let count = 0;
        for (const value of parsed) {
            const target = candidates.find(item => item.memory_id === value?.target_id);
            if (!target) throw new Error('记忆建议引用了本次未提供的目标');
            const draft = validateChangeDraft(value, target, sources);
            const prior = draft.action === 'correct_fact' ? target : oldRecords.find(item => item.memory_id === target.memory_id)?.current_reflection;
            if (prior && draft.content === prior.content && (draft.confidence === undefined || draft.confidence === prior.metadata?.confidence) && (draft.mood === undefined || draft.mood === prior.mood)) continue;
            const saved = await submitMemoryChange(input.cloud, input.charId, target, draft, sources);
            if (saved.status === 'pending') count++;
        }
        try { localStorage.setItem(storageKey, JSON.stringify([...readChecked().filter(value => value !== key), key].slice(-128))); } catch { /* Session map still deduplicates concurrent checks. */ }
        announce(input.charId);
        return count;
    })();
    runningChecks.set(key, job);
    try { return await job; } finally { runningChecks.delete(key); }
}
