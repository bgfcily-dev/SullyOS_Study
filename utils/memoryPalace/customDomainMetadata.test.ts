import { afterEach, describe, expect, it, vi } from 'vitest';
import { areEventBoxesDisabled } from './eventBoxPolicy';
import { metadataEnabled, upsertVector } from './supabaseVector';
import { supportsMemoryChanges } from './changeClient';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
describe('reviewed memory backend on custom domains', () => {
    it('recognizes the authenticated backend and retains event/reflection links on upload', async () => {
        const config = { enabled: true, initialized: true, supabaseUrl: 'https://custom-memory.example', supabaseAnonKey: 'test' };
        const fetch = vi.fn(async (url: string | URL) => String(url).endsWith('/health')
            ? Response.json({backend:'cloudflare-memory-sync',capabilities:['confirmed_memory_changes_v1','memory_metadata_v1']})
            : new Response(null,{status:204}));
        vi.stubGlobal('fetch',fetch);
        expect(metadataEnabled(config)).toBe(false);
        expect(await areEventBoxesDisabled('c',config)).toBe(true);
        expect(metadataEnabled(config)).toBe(true);
        expect(supportsMemoryChanges(config)).toBe(true);
        const metadata = {kind:'reflection' as const,event_id:'event',status:'active'};
        await upsertVector(config,'reflection','c',[1,0],{id:'reflection',charId:'c',content:'我很开心',room:'study',importance:5,mood:'happy',tags:[],createdAt:1,lastAccessedAt:1,accessCount:0,embedded:true,metadata},2);
        const init = (fetch.mock.calls[1] as unknown as [unknown, RequestInit])[1];
        expect(JSON.parse(String(init.body)).metadata).toEqual(metadata);
    });
    it('does not treat unrelated custom sites or legacy Supabase as a reviewed backend', async () => {
        const fetch = vi.fn(async () => Response.json({capabilities:['confirmed_memory_changes_v1']}));
        vi.stubGlobal('fetch',fetch);
        const config = {enabled:true,initialized:true,supabaseUrl:'https://unrelated-memory.example',supabaseAnonKey:'test'};
        expect(await areEventBoxesDisabled('c',config)).toBe(false);
        expect(metadataEnabled(config)).toBe(false);
        expect(supportsMemoryChanges(config)).toBe(false);
        expect(await areEventBoxesDisabled('c',{...config,supabaseUrl:'https://old.supabase.co'})).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
