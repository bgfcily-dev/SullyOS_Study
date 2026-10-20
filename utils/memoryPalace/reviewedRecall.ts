import type { Message } from '../../types';
import type { EmbeddingConfig, RemoteVectorConfig, MemoryNode } from './types';
import { hybridSearch } from './hybridSearch';
import { MemoryNodeDB } from './db';
import { fetchChangeMemories } from './changeClient';
import { asksIdentityHistory, formatMemoryContext, resolveCurrentMemoryState, type CurrentMemoryRecord } from './currentState';
import { sanitizeQuerySourceMessages } from './querySanitizer';
import { recordRecallReceipt } from './recallReceipts';
import { readMemoryMetadata } from './metadata';

/** Independent recall with existing importance/room ranking; no boxes, model calls or memory writes. */
export async function recallReviewedMemories(messages: Message[], charId: string, embedding: EmbeddingConfig, cloud?: RemoteVectorConfig, queryOverride?: string): Promise<string> {
    const visible = sanitizeQuerySourceMessages(messages);
    const query = (queryOverride || visible.filter(message => message.role !== 'system').slice(-3).map(message => message.content).join('\n')).slice(-2000).trim();
    if (!query) return '';
    const scored = await hybridSearch(query, charId, embedding, 24, cloud);
    const toRecord = (node: MemoryNode, similarity = 0): CurrentMemoryRecord => ({ memoryId: node.id, content: node.content, room: node.room, importance: node.importance, similarity, metadata: node.metadata, archived: node.archived, isSummary: node.isBoxSummary });
    const remote = !!(cloud?.enabled && cloud.initialized);
    const fresh = remote ? await fetchChangeMemories(cloud!, charId, scored.map(item => item.node.id)) : [];
    const fromRemote = (row: typeof fresh[number], similarity = 0): CurrentMemoryRecord => ({ memoryId: row.memory_id, content: row.content, room: row.room || 'living_room', importance: row.importance || 5, similarity, metadata: readMemoryMetadata(row.metadata), archived: row.archived, isSummary: row.is_summary });
    const candidates = scored.flatMap(item => {
        if (!remote) return [toRecord(item.node, item.similarity)];
        const row = fresh.find(value => value.memory_id === item.node.id && value.char_id === charId);
        return row ? [fromRemote(row, item.similarity)] : [];
    });
    const load = async (id: string) => {
        if (remote) {
            const rows = await fetchChangeMemories(cloud!, charId, [id]);
            const row = rows.find(value => value.memory_id === id && value.char_id === charId);
            return row ? fromRemote(row, candidates.find(value => value.memoryId === id)?.similarity || 0) : undefined;
        }
        const node = await MemoryNodeDB.getById(id);
        return node?.charId === charId ? toRecord(node) : undefined;
    };
    const records = await resolveCurrentMemoryState(candidates, load, asksIdentityHistory(visible.filter(message => message.role === 'user').at(-1)?.content || ''));
    recordRecallReceipt(charId, records.map(item => item.memoryId));
    return formatMemoryContext(records);
}
