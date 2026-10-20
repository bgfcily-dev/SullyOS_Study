import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ DB: { getRecentMessagesByCharId: vi.fn() } }));
vi.mock('../safeApi', () => ({ safeFetchJson: vi.fn(), extractContent: vi.fn() }));
vi.mock('./db', () => ({ MemoryNodeDB: {} }));
vi.mock('./eventBoxPolicy', () => ({ areEventBoxesDisabled: vi.fn(async () => true) }));
vi.mock('./changeClient', () => ({ checkMemoryChanges: vi.fn(async () => 1), fetchChangeMemories: vi.fn(async () => []) }));
import { DB } from '../db';
import { checkMemoryChanges, fetchChangeMemories } from './changeClient';
import { stageInstantMemoryCheck, checkLandedInstantMemories } from './confirmedChanges';
import { recordRecallReceipt } from './recallReceipts';
import type { Message } from '../../types';

beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    localStorage.setItem('os_remote_vector_config', JSON.stringify({ enabled: true, initialized: true, supabaseUrl: 'https://memory.test.workers.dev', supabaseAnonKey: 'cloud-secret' }));
    localStorage.setItem('os_memory_palace_config', JSON.stringify({ lightLLM: { baseUrl: 'https://llm.test', apiKey: 'llm-secret', model: 'model' } }));
    vi.mocked(DB.getRecentMessagesByCharId).mockResolvedValue([
        { role: 'assistant', content: '无关的另一轮', metadata: { activeMsg2: { taskUuid: 'other' } } },
        { role: 'assistant', content: '这轮的新理解', metadata: { activeMsg2: { taskUuid: 'uuid' } } },
    ] as Message[]);
});
describe('instant reply review staging', () => {
    it('stores only the actual turn’s receipt/evidence and waits for its committed reply', async () => {
        const since = Date.now(); recordRecallReceipt('c', ['e']);
        stageInstantMemoryCheck('c', 'uuid', [{ role: 'user', content: '旧对话' }, { role: 'assistant', content: '旧回复' }, { role: 'user', content: '更正这件事' }] as Message[], since);
        const stored = localStorage.getItem('memory-change-round:v1:uuid')!;
        expect(stored).not.toContain('secret'); expect(stored).not.toContain('旧对话');
        expect(checkMemoryChanges).not.toHaveBeenCalled();
        expect(await checkLandedInstantMemories('other', 'uuid')).toBe(0);
        expect(await checkLandedInstantMemories('c', 'uuid')).toBe(1);
        expect(checkMemoryChanges).toHaveBeenCalledWith(expect.objectContaining({ charId: 'c', sources: [{ role: 'user', content: '更正这件事' }, { role: 'assistant', content: '这轮的新理解' }] }));
        expect(localStorage.getItem('memory-change-round:v1:uuid')).toBeNull();
        expect(await checkLandedInstantMemories('c', 'uuid')).toBe(0);
    });
    it('cannot use a previous round’s receipt or an unrelated replacement cloud', async () => {
        recordRecallReceipt('c', ['old']);
        stageInstantMemoryCheck('c', 'old-uuid', [{ role: 'user', content: '新问题' }] as Message[], Date.now() + 1000);
        expect(localStorage.getItem('memory-change-round:v1:old-uuid')).toBeNull();
        stageInstantMemoryCheck('c', 'uuid', [{ role: 'user', content: '新问题' }] as Message[], 0);
        localStorage.setItem('os_remote_vector_config', JSON.stringify({ enabled: true, initialized: true, supabaseUrl: 'https://other.test.workers.dev' }));
        expect(await checkLandedInstantMemories('c', 'uuid')).toBe(0);
        expect(fetchChangeMemories).not.toHaveBeenCalled();
    });
});
