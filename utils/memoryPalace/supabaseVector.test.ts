import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVectorCount, parseRemoteVector, syncLocalToRemote, upsertVector, searchVectors, fetchRemoteVectorsForCharacter } from './supabaseVector';

afterEach(() => vi.unstubAllGlobals());

describe('Cloudflare memory metadata transport', () => {
    const config = { enabled: true, initialized: true, supabaseUrl: 'https://memory-sync.example.workers.dev', supabaseAnonKey: 'test' };
    const metadata = { kind: 'identity' as const, status: 'active', future: { key: true } };
    it('sends metadata to CF without requiring old Supabase installations to add a column', async () => {
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
        vi.stubGlobal('fetch', fetchMock);
        const node = { id: 'm', charId: 'c', content: '迁移', room: 'self_room' as const, importance: 5, tags: [], mood: 'neutral', createdAt: 1, lastAccessedAt: 1, accessCount: 0, embedded: true, metadata };
        await upsertVector(config, 'm', 'c', [1, 0], node, 2);
        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).metadata).toEqual(metadata);
        await upsertVector({ ...config, supabaseUrl: 'https://old.supabase.co' }, 'm', 'c', [1, 0], node, 2);
        expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).not.toHaveProperty('metadata');
    });
    it('retains metadata in recall and downloaded local snapshots', async () => {
        const row = { memory_id: 'm', char_id: 'c', content: '迁移', room: 'self_room', vector: '[1,0]', dimensions: 2, metadata };
        const fetchMock = vi.fn(async () => new Response(JSON.stringify([row])));
        vi.stubGlobal('fetch', fetchMock);
        expect((await searchVectors(config, [1, 0], 'c'))[0].metadata).toEqual(metadata);
        const onBatch = vi.fn();
        await fetchRemoteVectorsForCharacter(config, 'c', onBatch);
        expect(onBatch.mock.calls[0][0][0].node.metadata).toEqual(metadata);
    });
});

describe('remote vector decoding', () => {
    it('decodes pgvector text returned by PostgREST', () => {
        expect(Array.from(parseRemoteVector('[0.25,-1,2]') || [])).toEqual([0.25, -1, 2]);
    });

    it('rejects malformed vectors', () => {
        expect(parseRemoteVector('[1,nope,3]')).toBeNull();
        expect(parseRemoteVector('')).toBeNull();
    });
});

describe('remote vector migration', () => {
    const config = { enabled: true, initialized: true, supabaseUrl: 'https://memory.example', supabaseAnonKey: 'test' };

    it('splits rejected batches so valid vectors are still uploaded and progress is accurate', async () => {
        const sizes: number[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Range': '*/0' } });
            const rows = JSON.parse(String(init.body));
            sizes.push(rows.length);
            return new Response(null, { status: rows.length > 3 ? 413 : 204 });
        }));
        const nodes = Array.from({ length: 7 }, (_, index) => ({
            memoryId: `m-${index}`, charId: 'char', vector: [0.25, 0.75], dimensions: 2,
            node: { id: `m-${index}`, charId: 'char', content: '记忆', room: 'living_room', importance: 5, tags: [], mood: '', createdAt: 1, lastAccessedAt: 1, accessCount: 0, embedded: true },
        }));
        const progress: number[][] = [];
        const result = await syncLocalToRemote(config, async () => nodes as any, (...counts) => progress.push(counts));
        expect(result).toEqual({ synced: 7, failed: 0, skipped: 0 });
        expect(sizes).toContain(7);
        expect(sizes).toContain(2);
        expect(progress).toEqual([[0, 7, 0, 0, 0], [7, 7, 7, 0, 0]]);
    });

    it('counts only the bad row as failed after splitting a batch', async () => {
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Range': '*/0' } });
            const rows = JSON.parse(String(init.body));
            return new Response(null, { status: rows.some((row: { memory_id: string }) => row.memory_id === 'bad') ? 400 : 204 });
        }));
        const nodes = ['good', 'bad', 'also-good'].map(memoryId => ({
            memoryId, charId: 'char', vector: [0.25, 0.75], dimensions: 2,
            node: { id: memoryId, charId: 'char', content: '记忆', room: 'living_room', importance: 5, tags: [], mood: '', createdAt: 1, lastAccessedAt: 1, accessCount: 0, embedded: true },
        }));
        const result = await syncLocalToRemote(config, async () => nodes as any);
        expect(result).toEqual({ synced: 2, failed: 1, skipped: 0 });
    });

    it('uploads only missing IDs on a repeat sync, while force still rewrites all IDs', async () => {
        const existing = new Set(['good', 'also-good']);
        const posted: string[][] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            if (init.method === 'HEAD') {
                const filter = new URL(url).searchParams.get('memory_id') || '';
                const ids = filter.startsWith('in.(') ? filter.slice(4, -1).split(',') : [filter.slice(3)];
                const count = ids.filter(id => existing.has(id)).length;
                return new Response(null, { status: 200, headers: { 'Content-Range': `*/${count}` } });
            }
            const ids = JSON.parse(String(init.body)).map((row: { memory_id: string }) => row.memory_id);
            posted.push(ids);
            return new Response(null, { status: 204 });
        }));
        const nodes = ['good', 'bad', 'also-good'].map(memoryId => ({
            memoryId, charId: 'char', vector: [0.25, 0.75], dimensions: 2,
            node: { id: memoryId, charId: 'char', content: '记忆', room: 'living_room', importance: 5, tags: [], mood: '', createdAt: 1, lastAccessedAt: 1, accessCount: 0, embedded: true },
        }));
        expect(await syncLocalToRemote(config, async () => nodes as any)).toEqual({ synced: 1, failed: 0, skipped: 2 });
        expect(posted).toEqual([['bad']]);
        posted.length = 0;
        expect(await syncLocalToRemote(config, async () => nodes as any, undefined, { force: true })).toEqual({ synced: 3, failed: 0, skipped: 0 });
        expect(posted).toEqual([['good', 'bad', 'also-good']]);
    });

    it('stops instead of treating an unreadable cloud database as empty', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(syncLocalToRemote(config, async () => [{ memoryId: 'm1' }] as any)).rejects.toThrow('HTTP 503');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not report a failed count request as zero vectors', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
        await expect(getVectorCount(config)).rejects.toThrow('HTTP 503');
    });
});
