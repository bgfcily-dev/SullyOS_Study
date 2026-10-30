import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorDetail, loadErrorHistory, saveErrorHistory } from './errorHistory';
beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
describe('retained error details', () => {
    it('keeps the newest 20 errors across reloads and clears only on request', () => {
        const records = Array.from({ length: 24 }, (_, index) => ({ id: String(index), detail: `HTTP 429: ${index}`, createdAt: index }));
        saveErrorHistory(records); expect(loadErrorHistory()).toEqual(records.slice(0, 20));
        saveErrorHistory([]); expect(loadErrorHistory()).toEqual([]);
    });
    it('redacts configured keys and bearer credentials while retaining useful server details', () => {
        expect(errorDetail('HTTP 401: private-key; Bearer abc.def123; missing model', ['private-key'])).toBe('HTTP 401: [密钥已隐藏]; Bearer [已隐藏]; missing model');
        expect(errorDetail('x'.repeat(9000))).toContain('仅保留前 8000 字');
    });
    it('ignores malformed storage without interrupting the app', () => {
        localStorage.setItem('cookie_error_history_v1', '[{"id":"x","detail":null,"createdAt":1}]');
        expect(loadErrorHistory()).toEqual([]);
        localStorage.setItem('cookie_error_history_v1', 'invalid'); expect(loadErrorHistory()).toEqual([]);
    });
});
