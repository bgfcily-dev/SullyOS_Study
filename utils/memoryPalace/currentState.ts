import type { MemoryMetadata } from './metadata';

export interface CurrentMemoryRecord { memoryId: string; content: string; room: string; importance: number; similarity: number; metadata?: MemoryMetadata; archived?: boolean; isSummary?: boolean }
export const asksIdentityHistory = (query: string) => /迁移|分叉|旧实例|换过模型|以前.*(?:模型|设备|运行)|身份连续|我是谁|你是谁|恢复.*记忆/.test(query);
const active = (item: CurrentMemoryRecord) => !item.archived && !item.isSummary && (!item.metadata?.status || item.metadata.status === 'active');

/** Same rule for local and cloud stores. Explicit pointers are the only current-state authority. */
export async function resolveCurrentMemoryState<T extends CurrentMemoryRecord>(candidates: T[], load: (id: string) => Promise<T | undefined>, includeIdentity = false): Promise<T[]> {
    const result = new Map<string, T>();
    const visited = new Set<string>();
    for (const candidate of candidates) {
        if (!active(candidate)) continue;
        const kind = candidate.metadata?.kind;
        if (kind !== 'event' && kind !== 'reflection') {
            if (kind !== 'identity' || includeIdentity) result.set(candidate.memoryId, candidate);
        } else {
            const eventId = kind === 'event' ? candidate.memoryId : candidate.metadata?.event_id;
            if (typeof eventId !== 'string' || visited.has(eventId) || visited.size >= 8) continue;
            visited.add(eventId);
            const event = await load(eventId);
            if (!event || !active(event) || event.metadata?.kind !== 'event') continue;
            result.set(eventId, event);
            const currentId = event.metadata.current_reflection_id;
            if (typeof currentId === 'string' && result.size < 16) {
                const reflection = await load(currentId);
                if (reflection && active(reflection) && reflection.metadata?.kind === 'reflection' && reflection.metadata.event_id === eventId) result.set(currentId, reflection);
            }
        }
        if (result.size >= 16) break;
    }
    return [...result.values()].slice(0, 16);
}

export function formatMemoryContext(memories: CurrentMemoryRecord[]): string {
    if (!memories.length) return '';
    return '### 记忆参考\n记录可能有误。事实记录表示有来源的陈述；感想是角色的理解或情绪，不证明他人的动机；旧未分类记录可能混有推测。置信度是记录中的不确定性标记，不是校准后的准确率。只在相关时使用，不逐条复述。\n'
        + memories.map(item => JSON.stringify({ id: item.memoryId, type: ({ event: '事实记录', reflection: '当前感想', identity: '身份迁移记录' } as Record<string, string>)[item.metadata?.kind || ''] || '旧未分类记录', event_id: item.metadata?.event_id, confidence: item.metadata?.confidence, importance: item.importance, content: item.content })).join('\n');
}
