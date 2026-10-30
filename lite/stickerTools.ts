import type { LiteSticker } from './types';

export const STICKER_TOOL_NAME = 'send_sticker';
export const MAX_STICKERS_PER_REPLY = 3;
export interface StickerToolEntry { id: string; name: string }
/** Per-request IDs refer only to this snapshotted library. Image URLs never enter the model request. */
export function stickerToolCatalog(stickers: LiteSticker[]): StickerToolEntry[] {
    const names = new Set<string>();
    return stickers.flatMap((sticker, index) => {
        const name = sticker.name.trim();
        if (!name || names.has(name)) return [];
        try { if (!['http:', 'https:'].includes(new URL(sticker.url).protocol)) return []; } catch { return []; }
        names.add(name);
        return [{ id: 'sticker_' + index, name }];
    });
}
export function buildStickerTools(catalog: StickerToolEntry[]) {
    if (!catalog.length) return [];
    return [{ type: 'function', function: { name: STICKER_TOOL_NAME,
        description: '向当前聊天发送一张已有表情包。只有符合当前语气时才调用，不需要每轮发送。sticker_id 必须从本次提供的表情包清单选择；可以先说文字再调用，随后继续文字。',
        parameters: { type: 'object', properties: { sticker_id: { type: 'string', enum: catalog.map(sticker => sticker.id), description: '本次表情包清单里的真实 ID' } }, required: ['sticker_id'], additionalProperties: false },
    } }];
}
export function executeStickerTool(name: string, raw: unknown, catalog: StickerToolEntry[], sent: Set<string>): { sticker?: StickerToolEntry; result: Record<string, unknown> } {
    if (name !== STICKER_TOOL_NAME) return { result: { success: false, error: '未知工具：' + name + '，只允许使用 ' + STICKER_TOOL_NAME } };
    let args: unknown;
    try { args = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { result: { success: false, error: '参数不是有效 JSON，请使用 {"sticker_id":"清单中的 ID"}' } }; }
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'sticker_id') || typeof (args as Record<string, unknown>).sticker_id !== 'string') return { result: { success: false, error: '参数只能包含字符串 sticker_id' } };
    const id = (args as { sticker_id: string }).sticker_id;
    const sticker = catalog.find(item => item.id === id);
    if (!sticker) return { result: { success: false, error: '这个 ID 不在本次表情包清单中，请重新选择' } };
    if (sent.has(id)) return { result: { success: false, error: '这张表情包已加入本次回复，请继续文字，不要重复发送' } };
    if (sent.size >= MAX_STICKERS_PER_REPLY) return { result: { success: false, error: '本次回复最多发送 3 张表情包，请继续文字' } };
    sent.add(id);
    return { sticker, result: { success: true, sticker_id: id, name: sticker.name, message: '已加入本次回复' } };
}
/** Native mode never turns plain-text commands into executable sticker requests. */
export function cleanStickerCommandText(text: string): string {
    return text.replace(/\[{1,2}\s*(?:SEND_EMOJI|send_sticker)\s*[:：][^\]\n]*\]{1,2}/gi, '')
        .replace(/\[表情包[:：][^\]\n]*\]/g, '').trim();
}
