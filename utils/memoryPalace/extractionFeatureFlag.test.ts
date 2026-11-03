import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../../types';
import { safeFetchJson } from '../safeApi';
import { extractMemoriesFromBuffer } from './extraction';

vi.mock('../safeApi', () => ({
    safeFetchJson: vi.fn(),
}));

const mockedSafeFetchJson = vi.mocked(safeFetchJson);
const messages: Message[] = [{
    id: 1,
    charId: 'char-extraction-flags',
    role: 'user',
    type: 'text',
    content: '今天我和雾岚去了上海。',
    timestamp: new Date('2026-08-17T12:00:00+08:00').getTime(),
}];
const llmConfig = {
    baseUrl: 'https://memory.example/v1',
    apiKey: 'test-key',
    model: 'memory-model',
};

function extractionReply() {
    return {
        choices: [{
            message: {
                content: JSON.stringify([{
                    content: '用户今天和雾岚去了上海。',
                    room: 'user_room',
                    importance: 5,
                    mood: 'neutral',
                    tags: ['雾岚', '上海'],
                    entities: [
                        { name: '雾岚', type: 'person' },
                        { name: '上海', type: 'place' },
                    ],
                    date: '2026-08-17',
                }]),
            },
        }],
    };
}

function capturedSystemPrompt(): string {
    const options = mockedSafeFetchJson.mock.calls.at(-1)?.[1] as RequestInit;
    const body = JSON.parse(String(options.body));
    return body.messages[0].content;
}

describe('memory extraction smart-context compatibility gate', () => {
    beforeEach(() => {
        localStorage.clear();
        mockedSafeFetchJson.mockReset();
        mockedSafeFetchJson.mockResolvedValue(extractionReply() as any);
    });

    it('propagates API failure instead of reporting a successful empty extraction', async () => {
        mockedSafeFetchJson.mockRejectedValue(new Error('API 503'));
        await expect(extractMemoriesFromBuffer(messages, 'c1', '角色', llmConfig)).rejects.toThrow('API 503');
    });

    it.each(['', '服务暂时不可用', '{"error":[]}', '[{"content":"已完成的一条","room":"living_room"}, {"content":', '[{"content":"缺少房间"}]'])('rejects malformed or partial output: %s', async content => {
        mockedSafeFetchJson.mockResolvedValue({ choices: [{ message: { content } }] } as any);
        await expect(extractMemoriesFromBuffer(messages, 'c1', '角色', llmConfig)).rejects.toThrow();
    });

    it('accepts an explicit empty array as a successful extraction', async () => {
        mockedSafeFetchJson.mockResolvedValue({ choices: [{ message: { content: '```json\n[]\n```' } }] } as any);
        await expect(extractMemoriesFromBuffer(messages, 'c1', '角色', llmConfig)).resolves.toMatchObject({ memories: [] });
    });

    it('uses separate fact and optional linked reflection examples in the generation request', async () => {
        await extractMemoriesFromBuffer(messages, 'c1', '角色', llmConfig);
        const request = JSON.parse(String(mockedSafeFetchJson.mock.calls[0][1]?.body));
        const prompt = request.messages[0].content;
        expect(prompt).toContain('禁止把两者合成一段');
        expect(prompt).toContain('"kind": "reflection", "event_id": "N0"');
        expect(prompt).toContain('不要求每个事实都配感想');
        expect(prompt).not.toContain('那个眼睛亮起来的瞬间让我很开心');
    });

    it('rejects token-truncated output even if its JSON looks complete', async () => {
        mockedSafeFetchJson.mockResolvedValue({ choices: [{ finish_reason: 'length', message: { content: '[]' } }] } as any);
        await expect(extractMemoriesFromBuffer(messages, 'c1', '角色', llmConfig)).rejects.toThrow('截断');
    });

    it('separates new facts and reflections and resolves first-reflection links', async () => {
        const fact = { content: '用户说明当天断网。', room: 'user_room', metadata: { kind: 'event' } };
        const reflection = { content: '我不再认为是故意忽视。', room: 'bedroom', mood: 'peaceful', metadata: { kind: 'reflection', event_id: 'N0', confidence: 0.45 } };
        mockedSafeFetchJson.mockResolvedValue({ choices: [{ message: { content: JSON.stringify([fact, reflection]) } }] } as any);
        const { memories } = await extractMemoriesFromBuffer(messages, 'c1', '角色', llmConfig);
        expect(memories).toHaveLength(2);
        expect(memories[0].metadata).toEqual({ kind: 'event', status: 'active', current_reflection_id: memories[1].id });
        expect(memories[1].metadata).toEqual({ kind: 'reflection', status: 'active', event_id: memories[0].id, confidence: 0.45 });
        expect(capturedSystemPrompt()).toContain('不能由整理模型补造心理活动');
    });

    it('keeps the master prompt and memory shape when smart context is off', async () => {
        const result = await extractMemoriesFromBuffer(
            messages, 'char-extraction-flags', '测试角色', llmConfig, undefined, '用户',
        );
        const prompt = capturedSystemPrompt();

        expect(prompt).toContain('6. **标签**（tags）：提取 2-5 个关键词标签\n7. **不要遗漏重要记忆');
        expect(prompt).toContain('"tags": ["标签1", "标签2"],\n    "date": "YYYY-MM-DD"');
        expect(prompt).not.toContain('明确实体');
        expect(prompt).not.toContain('"entities"');
        expect(Object.prototype.hasOwnProperty.call(result.memories[0], 'entities')).toBe(false);
    });

    it('adds and stores entities only after recallRouter is enabled', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { recallRouter: true },
        }));

        const result = await extractMemoriesFromBuffer(
            messages, 'char-extraction-flags', '测试角色', llmConfig, undefined, '用户',
        );
        const prompt = capturedSystemPrompt();

        expect(prompt).toContain('明确实体');
        expect(prompt).toContain('"entities"');
        expect(result.memories[0].entities).toEqual([
            { name: '雾岚', type: 'person' },
            { name: '上海', type: 'place' },
        ]);
    });
});
