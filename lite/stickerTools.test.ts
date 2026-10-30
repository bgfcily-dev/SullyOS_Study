import { describe, expect, it } from 'vitest';
import { buildStickerTools, cleanStickerCommandText, executeStickerTool, stickerToolCatalog } from './stickerTools';
const catalog = stickerToolCatalog([{ name: '抱抱', url: 'https://private.test/hug.png' }, { name: '开心', url: 'https://private.test/happy.png' }]);
describe('native sticker tool validation', () => {
    it('exposes only real IDs and keeps image URLs out of tool definitions', () => {
        expect(buildStickerTools(catalog)[0].function.parameters.properties.sticker_id.enum).toEqual(['sticker_0', 'sticker_1']);
        expect(JSON.stringify(buildStickerTools(catalog))).not.toContain('private.test');
        expect(stickerToolCatalog([{ name: '坏链接', url: 'javascript:alert(1)' }])).toEqual([]);
        expect(buildStickerTools([])).toEqual([]);
    });
    it('executes only allowlisted IDs, never arbitrary URLs or invented names', () => {
        for (const args of ['bad JSON', '{"sticker_id":"unknown"}', '{"url":"https://evil.test"}', '{"sticker_id":"sticker_0","url":"https://evil.test"}']) {
            expect(executeStickerTool('send_sticker', args, catalog, new Set()).sticker).toBeUndefined();
        }
        expect(executeStickerTool('other_tool', '{"sticker_id":"sticker_0"}', catalog, new Set()).sticker).toBeUndefined();
        expect(executeStickerTool('send_sticker', '{"sticker_id":"sticker_0"}', catalog, new Set()).sticker?.name).toBe('抱抱');
    });
    it('prevents repeated selections and limits images within one reply', () => {
        const sent = new Set<string>();
        executeStickerTool('send_sticker', { sticker_id: 'sticker_0' }, catalog, sent);
        expect(executeStickerTool('send_sticker', { sticker_id: 'sticker_0' }, catalog, sent).result.success).toBe(false);
        const many = [...catalog, { id: '2', name: '第三张' }, { id: '3', name: '第四张' }];
        for (const id of ['sticker_1', '2']) executeStickerTool('send_sticker', { sticker_id: id }, many, sent);
        expect(executeStickerTool('send_sticker', { sticker_id: '3' }, many, sent).sticker).toBeUndefined();
    });
    it('does not execute old text markers in a native reply', () => {
        expect(cleanStickerCommandText('你好。[[SEND_EMOJI: 抱抱]][表情包：开心]')).toBe('你好。');
    });
});
