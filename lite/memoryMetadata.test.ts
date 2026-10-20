import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLiteMemoryDrafts, parseLiteSyncedMemoryRows, uploadPreparedLiteMemories } from './memoryTools';
import { getEmbeddings } from '../utils/memoryPalace/embedding';

vi.mock('../utils/memoryPalace/embedding', () => ({ getEmbeddings: vi.fn(), getEmbedding: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Lite new memory upload', () => {
    it('uploads separate event/reflection records with reciprocal real-ID links', async () => {
        const memories = parseLiteMemoryDrafts(JSON.stringify([
            { content: 'TA 今天解释了断网。', metadata: { kind: 'event' } },
            { content: '我不再认为是故意忽视。', mood: 'peaceful', metadata: { kind: 'reflection', event_id: 'N0', confidence: 0.45 } },
        ]));
        vi.mocked(getEmbeddings).mockResolvedValue([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
        vi.stubGlobal('fetch', fetchMock);
        await uploadPreparedLiteMemories({
            batch: { memories, charId: 'c1', contextSignature: 'msg1|msg2', createdAt: 1, usedMessages: 2 },
            cloud: { supabaseUrl: 'https://memory-sync.example.workers.dev', supabaseAnonKey: 'test', deviceId: 'test-device', deviceName: '测试设备' },
            embedding: { enabled: true, baseUrl: 'https://embedding.test', apiKey: 'test', model: 'test', dimensions: 2, extractionPrompt: '' },
        });
        const rows = JSON.parse(String(fetchMock.mock.calls[0][1].body));
        expect(rows[0].metadata).toEqual({ kind: 'event', status: 'active', current_reflection_id: rows[1].memory_id });
        expect(rows[1].metadata).toEqual({ kind: 'reflection', status: 'active', event_id: rows[0].memory_id, confidence: 0.45 });
        expect(rows[0].metadata.current_reflection_id).not.toMatch(/^N/);
        expect(rows[1].mood).toBe('peaceful');
    });
    it('retains future metadata when reading existing memories and leaves legacy unclassified', () => {
        const rows = parseLiteSyncedMemoryRows([
            { memory_id: 'lite_ctx_1', char_id: 'c1', content: 'new', metadata: { kind: 'identity', future: true } },
            { memory_id: 'lite_ctx_2', char_id: 'c1', content: 'old' },
        ]);
        expect(rows[0].metadata).toEqual({ kind: 'identity', future: true });
        expect(rows[1].metadata).toBeUndefined();
    });
});
