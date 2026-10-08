import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReceivedHandoff, fetchSharedContext, handoffSummaryInstructions, parseSharedContextRow, publishSharedContext, receiveHandoffMessages, type HandoffMessage } from './recentContextHandoff';
import { isMessageSemanticallyRelevant } from './messageFormat';

afterEach(() => vi.unstubAllGlobals());

describe('role ID handoff', () => {
  it('can publish the current character ID before there are recent messages', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      new Response(String(init.body), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishSharedContext({
      config: { supabaseUrl: 'https://memory.example', supabaseAnonKey: 'key', deviceId: 'main', deviceName: '原版' },
      charId: 'char-real-one', sharedMessages: [], localMessages: [], allowEmptyMessages: true,
    });
    expect(result.charId).toBe('char-real-one');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).char_id).toBe('char-real-one');
  });
});

describe('device relay envelope', () => {
  const config = { supabaseUrl: 'https://memory.example', supabaseAnonKey: 'key', deviceId: 'a', deviceName: '设备 A' };
  const conversation: HandoffMessage[] = Array.from({ length: 30 }, (_, i) => ({ id: `main:c:${i}`, role: i % 2 ? 'assistant' : 'user', content: `消息 ${i}`, createdAt: 1000 + i, origin: 'main' }));
  const summary = '现在是2026年10月8日15时30分，我刚才在讨论读书计划，接下来要进行迁移。';

  it('survives the existing Worker 30-message JSON storage and transfers into local history once', async () => {
    let stored: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      if (init?.method === 'POST') {
        stored = JSON.parse(init.body);
        stored!.messages = (stored!.messages as unknown[]).slice(-30);
      }
      return Response.json([stored]);
    }));
    await publishSharedContext({ config, charId: 'c', sharedMessages: [], localMessages: conversation, summary });
    const received = (await fetchSharedContext({ ...config, deviceId: 'b' }))!;
    expect(received.prompt).toBe(summary);
    expect(received.messages).toHaveLength(30);
    expect(received.sourceDeviceName).toBe('设备 A');
    const deviceB = { ...config, deviceId: 'b', deviceName: '设备 B' };
    const local = receiveHandoffMessages(received, deviceB, []);
    expect(local[0].content).toContain(`以下消息接收自 设备 A · 接收于 设备 B\n${summary}\n现在已迁移至 设备 B 继续对话。`);
    expect(local.filter(m => m.role !== 'system')).toHaveLength(29);
    expect(local.some(m => m.handoffKind === 'upload')).toBe(false);
    expect(receiveHandoffMessages(received, deviceB, local)).toBe(local);
    expect(receiveHandoffMessages(received, config, [])).toEqual([]);

    const next = await publishSharedContext({ config: deviceB, charId: 'c', sharedMessages: [], localMessages: local, summary: '接下来去设备 C。' });
    expect(next.sourceDeviceName).toBe('设备 B');
    expect(next.prompt).toBe('接下来去设备 C。');
    expect(next.messages.filter(m => m.role === 'system')).toHaveLength(1);
    expect(buildReceivedHandoff(next, { ...config, deviceId: 'c', deviceName: '设备 C' }).content).toContain('现在已迁移至 设备 C 继续对话');
  });

  it('accepts legacy prompt rows and does not invent a summary for older data', () => {
    expect(parseSharedContextRow({ messages: conversation, prompt: summary }).prompt).toBe(summary);
    expect(parseSharedContextRow({ messages: conversation }).prompt).toBe('');
    expect(parseSharedContextRow({ messages: [{ ...conversation[0], role: 'system', handoffKind: 'upload', handoffSummary: '最新迁移总结' }], prompt: '旧 prompt' }).prompt).toBe('最新迁移总结');
  });

  it('uses device local migration time and excludes handoff notices from memory extraction', () => {
    expect(handoffSummaryInstructions(new Date(2026, 9, 8, 15, 30))).toContain('2026年10月8日15时30分');
    for (const source of ['handoff_receive', 'handoff_upload']) {
      expect(isMessageSemanticallyRelevant({ id: 1, charId: 'c', role: 'system', type: 'text', content: summary, timestamp: 1000, metadata: { source } })).toBe(false);
    }
  });
});
