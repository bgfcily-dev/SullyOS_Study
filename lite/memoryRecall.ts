import { fetchEventDateMemories, queryEventDates } from '../utils/memoryPalace/eventDate';
import { asksIdentityHistory, resolveMemoryState } from './memoryState';
import { getEmbedding } from '../utils/memoryPalace/embedding';
import { searchVectors } from '../utils/memoryPalace/supabaseVector';
import type { LiteCloudConfig, LiteEmbeddingConfig, LiteMemoryRecall, LiteMessage } from './types';

export async function recallLiteMemories(input: {
  charId: string;
  messages: LiteMessage[];
  cloud: LiteCloudConfig;
  embedding: LiteEmbeddingConfig;
}): Promise<LiteMemoryRecall[]> {
  const { charId, messages, cloud, embedding } = input;
  if (!charId.trim() || !embedding.enabled) return [];
  if (!embedding.baseUrl || !embedding.apiKey || !embedding.model) {
    throw new Error('长期记忆已开启，但 Embedding API 尚未填写完整');
  }
  const query = messages
    .filter(message => message.role !== 'system')
    .slice(-3)
    .map((message) => message.content)
    .join('\n')
    .slice(-2000)
    .trim();
  if (!query) return [];

  const vector = await getEmbedding(query, {
    baseUrl: embedding.baseUrl,
    apiKey: embedding.apiKey,
    model: embedding.model,
    dimensions: embedding.dimensions,
  });
  if (vector.length !== embedding.dimensions) {
    throw new Error(`Embedding 返回 ${vector.length} 维，但当前配置是 ${embedding.dimensions} 维`);
  }
  const rows = await searchVectors({
    enabled: true,
    supabaseUrl: cloud.supabaseUrl,
    supabaseAnonKey: cloud.supabaseAnonKey,
    initialized: true,
  }, vector, charId, 0.3, 24);

  const candidates = rows.map((row) => ({
    memoryId: row.memoryId,
    content: row.content,
    room: row.room,
    importance: row.importance,
    similarity: row.similarity,
    metadata: row.metadata,
    archived: row.archived,
    isSummary: row.isSummary,
  }));
  const dateRows = await fetchEventDateMemories(cloud, charId, queryEventDates(messages.filter(message => message.role === 'user').at(-1)?.content || ''));
  for (const row of dateRows.reverse()) {
    const index = candidates.findIndex(item => item.memoryId === row.memory_id);
    if (index >= 0) candidates.splice(index, 1);
    candidates.unshift({ memoryId: row.memory_id, content: row.content, room: row.room,
      importance: row.importance, similarity: 1, metadata: row.metadata, archived: !!row.archived, isSummary: !!row.is_summary });
  }
  candidates.splice(24);
  return resolveMemoryState(candidates, cloud, charId, asksIdentityHistory(messages.filter(message => message.role === 'user').at(-1)?.content || ''));
}
