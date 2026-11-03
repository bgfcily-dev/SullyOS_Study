import { afterEach, describe, expect, it, vi } from 'vitest';
import { blank, cached, exchange, requestCognitionCloud } from './cognition';

const cloud = { supabaseUrl: 'https://memory.example', supabaseAnonKey: 'test' };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
describe('cognition network errors', () => {
    it('keeps cached state and identifies an uncertain save after cancellation', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('fetch is aborted', 'AbortError')));
        await expect(exchange(cloud, 'c', { ...blank, self: '我' })).rejects.toThrow('云端可能已保存');
        expect(cached(cloud, 'c')).toEqual(blank);
    });
    it('identifies the material read separately from the model generation', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('fetch is aborted', 'AbortError')));
        await expect(requestCognitionCloud(cloud, '/rest/v1/memory_vectors', '生成草稿前读取云端记忆')).rejects.toThrow('生成草稿前读取云端记忆请求被');
    });
    it('rejects an incomplete URL before sending a relative request', async () => {
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        await expect(exchange({ ...cloud, supabaseUrl: 'memory.example' }, 'c')).rejects.toThrow('https://');
        expect(fetch).not.toHaveBeenCalled();
    });
});
