import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { checkMemoryChanges, decideMemoryChange } from './changeClient';
import type { ChangeMemory, MemoryChangeProposal } from './changeContract';

const cloud = { supabaseUrl: 'https://memory.test.workers.dev', supabaseAnonKey: 'test-key' };
const event: ChangeMemory = { memory_id: 'e1', char_id: 'c1', content: '用户住在上海。', metadata: { kind: 'event' } };
const sources = [{ role: 'user', content: '更正，我住在北京。' }, { role: 'assistant', content: '知道原因后，我不再觉得自己被忽视。' }];
const draft = { action: 'correct_fact', target_id: 'e1', content: '用户住在北京。', reason: '用户明确更正', evidence: [sources[0].content] };
const proposal = { ...draft, id: 'p1', char_id: 'c1', status: 'pending', before: event, current_reflection: null, created_at: 1 } as MemoryChangeProposal;
beforeEach(() => { localStorage.clear(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(proposal)))); });
afterEach(() => { vi.unstubAllGlobals(); });
const input = (run: (system: string, user: string) => Promise<string>, candidates = [event]) => ({ cloud, charId: 'c1', candidates, sources, run });

describe('new-conversation memory proposals', () => {
    it('checks an unchanged conversation once and writes nothing, including after another call', async () => {
        const run = vi.fn(async () => '[]');
        expect(await checkMemoryChanges(input(run))).toBe(0);
        expect(await checkMemoryChanges(input(run))).toBe(0);
        expect(run).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
        expect(localStorage.getItem('memory-change-checks:v1')).not.toContain(sources[0].content);
        expect(localStorage.getItem('memory-change-checks:v1')).not.toContain('test-key');
    });
    it('deduplicates overlapping checks and only creates pending proposals, never approvals', async () => {
        const run = vi.fn(async () => { await Promise.resolve(); return JSON.stringify([draft]); });
        const counts = await Promise.all([checkMemoryChanges(input(run)), checkMemoryChanges(input(run))]);
        expect(counts[0]).toBe(1); expect([0, 1]).toContain(counts[1]);
        expect(run).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
        const [url, options] = vi.mocked(fetch).mock.calls[0];
        expect(String(url)).toMatch(/\/memory\/change-proposals$/);
        const body = JSON.parse(options!.body as string);
        expect(body).toMatchObject({ base: { content: event.content, metadata: event.metadata }, sources });
        expect(body.confirmed).toBeUndefined(); expect(body.vector).toBeUndefined();
    });
    it('requires fresh user evidence and a real target; failed checks can retry', async () => {
        for (const invalid of [{ ...draft, evidence: ['编造的原句'] }, { ...draft, target_id: 'other' }]) {
            await expect(checkMemoryChanges(input(async () => JSON.stringify([invalid])))).rejects.toThrow();
        }
        expect(fetch).not.toHaveBeenCalled();
        expect(await checkMemoryChanges(input(async () => JSON.stringify([draft])))).toBe(1);
    });
    it('does not send identity, summaries, archived records or other roles to a model', async () => {
        const run = vi.fn(async () => '[]');
        const excluded = [{ ...event, metadata: { kind: 'identity' } }, { ...event, is_summary: true }, { ...event, archived: true }, { ...event, char_id: 'other' }] as ChangeMemory[];
        expect(await checkMemoryChanges(input(run, excluded))).toBe(0);
        expect(run).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
    it('requires the character to have expressed a new reflection and passes only its explicit current version', async () => {
        const target = { ...event, metadata: { kind: 'event', current_reflection_id: 'r1' } } as ChangeMemory;
        const current = { ...event, memory_id: 'r1', content: '我觉得被忽视。', metadata: { kind: 'reflection', event_id: 'e1' } } as ChangeMemory;
        const reflection = { ...draft, action: 'revise_reflection', content: sources[1].content };
        await expect(checkMemoryChanges(input(async () => JSON.stringify([reflection]), [target, current]))).rejects.toThrow('新感想');
        const run = vi.fn(async (_system: string, _user: string) => JSON.stringify([{ ...reflection, evidence: sources.map(source => source.content), confidence: .45 }]));
        expect(await checkMemoryChanges(input(run, [target, current]))).toBe(1);
        expect(JSON.parse(run.mock.calls[0][1]).existing_memories[0].current_reflection.memory_id).toBe('r1');
    });
    it('skips wording-identical facts even when the model includes a mood tag', async () => {
        const run = async () => JSON.stringify([{ ...draft, content: event.content, mood: 'sad' }]);
        expect(await checkMemoryChanges(input(run))).toBe(0); expect(fetch).not.toHaveBeenCalled();
    });
});
describe('explicit review decisions', () => {
    it('embeds the proposed complete text only for confirmation and sends the confirmed flag', async () => {
        const embed = vi.fn(async () => [0, 1]);
        await decideMemoryChange({ cloud, proposal, approve: true, embed, model: 'model' });
        expect(embed).toHaveBeenCalledWith(proposal.content);
        expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toMatchObject({ confirmed: true, vector: [0, 1], model: 'model' });
    });
    it('ignores a proposal with no embedding; embedding failure never submits an approval', async () => {
        const embed = vi.fn(async () => { throw new Error('429'); });
        await decideMemoryChange({ cloud, proposal, approve: false, embed });
        expect(embed).not.toHaveBeenCalled(); expect(String(vi.mocked(fetch).mock.calls[0][0])).toMatch(/\/reject$/);
        vi.mocked(fetch).mockClear();
        await expect(decideMemoryChange({ cloud, proposal, approve: true, embed, model: 'model' })).rejects.toThrow('429');
        expect(fetch).not.toHaveBeenCalled();
    });
});
