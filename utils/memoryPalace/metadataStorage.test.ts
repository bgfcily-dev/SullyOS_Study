import { describe, expect, it, vi } from 'vitest';
import { MemoryNodeDB } from './db';
import { getEmbeddings } from './embedding';
import { vectorizeAndStore } from './vectorStore';
import type { MemoryNode } from './types';

vi.mock('./embedding', async (importOriginal) => ({
    ...await importOriginal<typeof import('./embedding')>(), getEmbeddings: vi.fn(),
}));

describe('new fact/reflection storage integrity', () => {
    it('keeps both linked records even when their embeddings are identical', async () => {
        const base: MemoryNode = { id: 'metadata-store-event', charId: 'metadata-store-char', content: '我得知断网原因。', room: 'living_room', tags: [], importance: 5, mood: 'neutral', embedded: false, createdAt: 1, lastAccessedAt: 1, accessCount: 0 };
        const nodes: MemoryNode[] = [
            { ...base, metadata: { kind: 'event', current_reflection_id: 'metadata-store-reflection' } },
            { ...base, id: 'metadata-store-reflection', content: '我因此不再猜测被忽视。', metadata: { kind: 'reflection', event_id: base.id } },
        ];
        vi.mocked(getEmbeddings).mockResolvedValue([Float32Array.from([1, 0]), Float32Array.from([1, 0])]);
        expect(await vectorizeAndStore(nodes, { baseUrl: 'test', apiKey: 'test', model: 'test', dimensions: 2 })).toEqual({ stored: 2, skipped: 0 });
        expect((await MemoryNodeDB.getById(nodes[0].id))?.metadata?.current_reflection_id).toBe(nodes[1].id);
        expect((await MemoryNodeDB.getById(nodes[1].id))?.metadata?.event_id).toBe(nodes[0].id);
    });
});
