/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import RecentContextHandoffModal from '../components/chat/RecentContextHandoffModal';
import ChatInputArea from '../components/chat/ChatInputArea';
import { DB } from './db';

const conversation = [
  { id: 1, charId: 'tree', role: 'user', type: 'text', content: '小树，陪我读书吧', timestamp: 1000 },
  { id: 2, charId: 'tree', role: 'assistant', type: 'text', content: '我正在陪你读第一章。', timestamp: 1001 },
];
vi.mock('../context/OSContext', () => ({ useOS: () => ({ apiConfig: { baseUrl: 'https://global.example/v1', apiKey: 'global-key', model: 'global' }, userProfile: { name: '小雨', persona: '' } }) }));
vi.mock('./chatContextRange', () => ({ loadCharacterContextMessages: async () => conversation }));
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows a visible sync-context entry on the first page of the SullyOS chat action menu', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const action = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(ChatInputArea, {
    input: '', setInput: vi.fn(), isTyping: false, selectionMode: false, showPanel: 'actions', setShowPanel: vi.fn(),
    onSend: vi.fn(), onDeleteSelected: vi.fn(), onForwardSelected: vi.fn(), onFavoriteSelected: vi.fn(), selectedCount: 0,
    emojis: [], onPanelAction: action, onImageSelect: vi.fn(), isSummarizing: false, onReroll: vi.fn(), canReroll: false,
  } as any)));
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === '同步上下文')!;
  expect(button).toBeTruthy();
  act(() => button.click());
  expect(action).toHaveBeenCalledWith('handoff');
});

it('SullyOS generates a character POV summary and opens a separate editable preview before upload', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(DB, 'getRecentMessagesWithCount').mockResolvedValue({ messages: conversation as any, total: 2 } as any);
  const save = vi.spyOn(DB, 'saveMessage').mockResolvedValue(10);
  const imported = vi.fn();
  const calls: Array<{ url: string; method: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), method: init?.method || 'GET', body });
    if (String(url).includes('/chat/completions')) return Response.json({ choices: [{ message: { content: '我刚才在陪小雨读第一章，接下来我要迁移到另一台设备继续对话。' } }] });
    return Response.json(body ? [body] : []);
  }));
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(RecentContextHandoffModal, {
    isOpen: true, onClose: vi.fn(), character: { id: 'tree', name: '小树', systemPrompt: '你是小树。', worldview: '', worldbooks: [], dialogueApi: { baseUrl: 'https://character.example/v1', apiKey: 'character-key', model: 'character-model' }, customTimezoneEnabled: true, customTimezone: 'Asia/Tokyo' } as any,
    userName: '小雨', remoteVectorConfig: { enabled: true, supabaseUrl: 'https://sync.example', supabaseAnonKey: 'sync-key' } as any, onImported: imported,
  })));
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!;
    expect(button).toBeTruthy();
    await act(async () => { button.click(); });
  };
  await click('同步上下文 · 生成总结并预览');
  const request = calls.find(c => c.url.includes('/chat/completions'))!;
  expect(request.url).toBe('https://character.example/v1/chat/completions');
  expect(request.body.messages.at(-1).content).toContain('以角色「小树」的第一人称');
  expect(request.body.messages.at(-1).content).toContain('“我”始终指角色本人，不是用户');
  expect(host.querySelector('h3')?.textContent).toBe('迁移总结预览');
  expect(host.textContent).not.toContain('接收其他设备的上下文');
  expect(calls.filter(c => c.url.includes('shared_recent_contexts') && c.method === 'POST')).toHaveLength(0);
  expect(save).not.toHaveBeenCalled();
  await click('取消');
  expect(host.querySelector('h3')?.textContent).toBe('跨设备接力');
  await click('同步上下文 · 生成总结并预览');
  const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="角色迁移总结"]')!;
  act(() => Simulate.change(textarea, { target: { value: '我刚才在陪小雨读第二章，接下来继续陪她读书。' } } as any));
  await click('确认并上传');
  const upload = calls.find(c => c.url.includes('shared_recent_contexts') && c.method === 'POST')!;
  expect(upload.body.messages.find((m: any) => m.handoffKind === 'upload').handoffSummary).toBe('我刚才在陪小雨读第二章，接下来继续陪她读书。');
  expect(imported).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
});
