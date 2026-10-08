import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractLiteTokenUsage, requestLiteReply } from './chatApi';
import { buildReceivedHandoff } from '../utils/recentContextHandoff';

afterEach(() => vi.unstubAllGlobals());

it('uses imported local history and its migration marker, without re-sending the cloud buffer', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const fetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: '继续读书吧' } }] }));
  vi.stubGlobal('fetch', fetchMock);
  const cloud = { brainId: 'primary' as const, charId: 'c', sourceDeviceId: 'a', sourceDeviceName: '设备 A', revision: 1, updatedAt: 1000, messages: [], prompt: '我刚才在看书，接下来要进行迁移。' };
  await requestLiteReply({ api: { id: 'api', name: 'api', baseUrl: 'https://api.example/v1', apiKey: 'key', model: 'model' },
    identity: { characterName: '树', userName: '雨', characterAvatar: '', systemPrompt: '', userPrompt: '' },
    cloudContext: { ...cloud, prompt: '不得重复发送的云端 prompt', messages: [{ id: 'stale', role: 'user', origin: 'main', content: '不得重复发送的旧云端消息', createdAt: 10 }] },
    localMessages: [buildReceivedHandoff(cloud, { supabaseUrl: '', supabaseAnonKey: '', deviceId: 'b', deviceName: '设备 B' }),
      { id: 'upload', role: 'system', origin: 'lite', createdAt: 1001, content: '上传于 设备 B', handoffKind: 'upload' },
      { id: 'local', role: 'user', origin: 'lite', createdAt: 1002, content: '继续刚才的读书计划' }],
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String((fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1].body));
  const content = body.messages.map((m: { content: string }) => m.content).join('\n');
  expect(content).toContain('以下消息接收自 设备 A');
  expect(content).toContain(cloud.prompt);
  expect(content).toContain('现在已迁移至 设备 B 继续对话');
  expect(content).not.toContain('不得重复发送');
  expect(content).not.toContain('上传于 设备 B');
});

describe('Sully Lite token usage', () => {
  it('reads OpenAI-compatible prompt and completion usage', () => {
    expect(extractLiteTokenUsage({ prompt_tokens: 1200, completion_tokens: 86, total_tokens: 1286 })).toEqual({
      promptTokens: 1200,
      completionTokens: 86,
      totalTokens: 1286,
    });
  });

  it('supports input/output aliases and derives the total', () => {
    expect(extractLiteTokenUsage({ input_tokens: 900, output_tokens: 100 })).toEqual({
      promptTokens: 900,
      completionTokens: 100,
      totalTokens: 1000,
    });
  });

  it('returns null when the provider omits usage', () => {
    expect(extractLiteTokenUsage(undefined)).toBeNull();
    expect(extractLiteTokenUsage({ total_tokens: 0 })).toBeNull();
  });
});
