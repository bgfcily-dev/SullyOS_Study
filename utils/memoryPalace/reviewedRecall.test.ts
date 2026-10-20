import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./hybridSearch', () => ({ hybridSearch: vi.fn() }));
vi.mock('./db', () => ({ MemoryNodeDB: { getById: vi.fn(), save: vi.fn() } }));
vi.mock('./changeClient', () => ({ fetchChangeMemories: vi.fn() }));
import { hybridSearch } from './hybridSearch';
import { MemoryNodeDB } from './db';
import { fetchChangeMemories } from './changeClient';
import { recallReviewedMemories } from './reviewedRecall';
import { getLatestRecallReceipt } from './recallReceipts';
import type { Message } from '../../types';
import type { EmbeddingConfig, RemoteVectorConfig } from './types';

const cloud = { enabled: true, initialized: true, supabaseUrl: 'https://memory.test.workers.dev', supabaseAnonKey: 'key' } as RemoteVectorConfig;
const embedding = {} as EmbeddingConfig;
const messages = [{ role: 'user', content: '一起看星星的那次呢？' }] as Message[];
const rows = [
    { memory_id: 'e', char_id: 'c', content: '云端修正后的事实。', metadata: { kind: 'event', current_reflection_id: 'new' } },
    { memory_id: 'old', char_id: 'c', content: '过时的感想。', metadata: { kind: 'reflection', event_id: 'e' } },
    { memory_id: 'new', char_id: 'c', content: '现在有效的感想。', metadata: { kind: 'reflection', event_id: 'e' } },
    { memory_id: 'summary', char_id: 'c', content: '旧盒子大总结。', is_summary: true },
    { memory_id: 'identity', char_id: 'c', content: '换过运行环境。', metadata: { kind: 'identity' } },
];
beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    vi.mocked(hybridSearch).mockResolvedValue(rows.filter(row => row.memory_id !== 'new').map(row => ({ node: { id: row.memory_id, content: '本机过期文本', eventBoxId: 'box', charId: 'c' }, similarity: .8 })) as any);
    vi.mocked(fetchChangeMemories).mockImplementation(async (_cloud, _char, ids) => rows.filter(row => ids.includes(row.memory_id)) as any);
});
describe('reviewed cloud recall', () => {
    it('refreshes cloud versions, follows the current pointer and never expands boxes or rewrites memories', async () => {
        const context = await recallReviewedMemories(messages, 'c', embedding, cloud);
        expect(context).toContain('云端修正后的事实。'); expect(context).toContain('现在有效的感想。');
        for (const old of ['本机过期文本', '过时的感想。', '旧盒子大总结。', '换过运行环境。']) expect(context).not.toContain(old);
        expect(getLatestRecallReceipt('c')!.ids).toEqual(['e', 'new']);
        expect(MemoryNodeDB.save).not.toHaveBeenCalled();
        expect(vi.mocked(fetchChangeMemories).mock.calls.every(call => call[1] === 'c')).toBe(true);
    });
    it('includes identity history only when the conversation asks for it', async () => {
        const context = await recallReviewedMemories([{ role: 'user', content: '你什么时候换过模型？' }] as Message[], 'c', embedding, cloud);
        expect(context).toContain('换过运行环境。');
    });
    it('does not fallback to stale local content when a cloud record no longer exists', async () => {
        vi.mocked(fetchChangeMemories).mockResolvedValue([]);
        expect(await recallReviewedMemories(messages, 'c', embedding, cloud)).toBe('');
        expect(MemoryNodeDB.getById).not.toHaveBeenCalled(); expect(getLatestRecallReceipt('c')).toBeNull();
    });
});
