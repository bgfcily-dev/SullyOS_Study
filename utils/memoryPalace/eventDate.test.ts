import { describe, expect, it, vi, afterEach } from 'vitest';
import { normalizeEventDate, memoryEventDate, queryEventDates, matchesEventDate, fetchEventDateMemories } from './eventDate';
import { buildNewMemoryMetadata } from './metadata';
afterEach(() => vi.unstubAllGlobals());
describe('event dates', () => {
    it('validates calendar dates and keeps precision', () => {
        expect(['2026', '2026-10', '2024-02-29'].map(normalizeEventDate)).toEqual(['2026', '2026-10', '2024-02-29']);
        for (const invalid of ['2026-02-29', '2026-13', '0000', '2026-10-32']) expect(normalizeEventDate(invalid)).toBeUndefined();
        expect(queryEventDates('查2026-10-20和2026年10月21日')).toEqual(['2026-10-20', '2026-10-21']);
    });
    it('preserves dates on save and only reads canonical legacy headers', () => {
        expect(buildNewMemoryMetadata([{ content: '[2026-10-20]\n旅行', metadata: { kind: 'event' } }], ['e'])[0].event_date).toBe('2026-10-20');
        expect(memoryEventDate({ content: '计划2026-10-20旅行' })).toBeUndefined();
        expect(memoryEventDate({ content: '[2026-10-20]\n旅行', metadata: { event_date: '2025' } })).toBe('2025');
        expect(matchesEventDate({ content: '[2026-10]\n旅行' }, '2026-10-20')).toBe(false);
        expect(matchesEventDate({ content: '[2026-10-20]\n旅行' }, '2026-10')).toBe(true);
    });
    it('queries cloud dates without local download and rejects unrelated rows', async () => {
        const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify([
            { memory_id: 'a', char_id: 'c', content: '[2026-10-20]\n旅行' },
            { memory_id: 'b', char_id: 'other', content: '[2026-10-20]\n旅行' },
            { memory_id: 'c', char_id: 'c', content: '2026-10-20是引用' },
        ])));
        vi.stubGlobal('fetch', fetchMock);
        expect((await fetchEventDateMemories({ supabaseUrl: 'https://test.workers.dev', supabaseAnonKey: 'key' }, 'c', ['2026-10-20'])).map(row => row.memory_id)).toEqual(['a']);
        expect(fetchMock.mock.calls[0][0]).toContain('event_date=2026-10-20');
    });
});
