import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types';
import { DB } from '../db';
import { processNewMessages } from './pipeline';
import { extractMemoriesFromBuffer } from './extraction';
import { vectorizeAndStore } from './vectorStore';
import { getReliableMemoryPalaceHighWaterMark, setReliableMemoryPalaceHighWaterMark } from './highWaterMark';

vi.mock('./extraction', () => ({ extractMemoriesFromBuffer: vi.fn() }));
vi.mock('./vectorStore', async importOriginal => ({
    ...await importOriginal<typeof import('./vectorStore')>(),
    vectorizeAndStore: vi.fn(),
}));

const charId = 'extraction-failure-waterline';
const config = { baseUrl: 'https://test.invalid', apiKey: 'test', model: 'test', dimensions: 2 };
const empty = { memories: [], crossTimeLinks: [], eventBoxHints: [], unpinIds: [], corrections: [] };
const extract = vi.mocked(extractMemoriesFromBuffer);
const run = (drainBuffer = false) => processNewMessages([], charId, '角色', config, config, '', false, undefined,
    drainBuffer ? { drainBuffer: true, requireAllBatches: true } : {});

describe('failed extraction preserves the original message waterline', () => {
    beforeEach(async () => {
        localStorage.clear();
        vi.clearAllMocks();
        extract.mockReset();
        await setReliableMemoryPalaceHighWaterMark(charId, 10);
        vi.spyOn(DB, 'getMessagesByCharId').mockResolvedValue(Array.from({ length: 800 }, (_, i) => ({
            id: i + 1, charId, role: 'user', type: 'text', content: '你好', timestamp: 1,
        } as Message)));
        // Context lookup is optional; avoid unrelated retrieval requests in this regression.
        vi.spyOn(DB, 'getAllCharacters').mockRejectedValue(new Error('context unavailable'));
    });
    afterEach(() => vi.restoreAllMocks());

    it.each([false, true])('does not save a partially successful run or advance its waterline (drain=%s)', async drain => {
        extract.mockResolvedValue(empty)
            .mockResolvedValueOnce({ ...empty, memories: [{ id: 'candidate', content: '记忆' } as any] })
            .mockRejectedValueOnce(new Error('API 503'));
        const result = await run(drain);
        expect(result?.batches.some(batch => !batch.ok)).toBe(true);
        expect(vectorizeAndStore).not.toHaveBeenCalled();
        expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(10);

        // A retry starts with the same pending source messages, not after the failed range.
        const firstBatchIds = extract.mock.calls[0][0].map(message => message.id);
        extract.mockClear().mockResolvedValue(empty);
        await run(drain);
        expect(extract.mock.calls[0][0].map(message => message.id)).toEqual(firstBatchIds);
        expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(drain ? 800 : 10);
    });

    it('does not treat all failed one-shot batches as a successful empty result', async () => {
        extract.mockRejectedValue(new Error('API 503'));
        const result = await run(true);
        expect(result?.batches.every(batch => !batch.ok)).toBe(true);
        expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(10);
        expect(vectorizeAndStore).not.toHaveBeenCalled();
    });

    it('preserves the waterline when embedding or storage fails after extraction', async () => {
        extract.mockResolvedValue({ ...empty, memories: [{ id: 'candidate', content: '记忆' } as any] });
        vi.mocked(vectorizeAndStore).mockRejectedValueOnce(new Error('Embedding failed'));
        expect(await run(true)).toBeNull();
        expect(vectorizeAndStore).toHaveBeenCalledOnce();
        expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(10);
    });
});
