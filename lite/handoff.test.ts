/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { LiteApp } from './LiteApp';
import { saveApiProfiles, saveCloudConfig, saveLocalMessages } from './storage';

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('previews before uploading, shows device capsules, and keeps received context locally across reload', async () => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
  saveApiProfiles([{ id: 'a', name: 'test', baseUrl: 'https://api.example/v1', apiKey: 'test-key', model: 'test-model' }], 'a');
  saveCloudConfig({ supabaseUrl: 'https://memory.example', supabaseAnonKey: 'test-key', deviceId: 'b', deviceName: '设备 B' });
  saveLocalMessages([{ id: 'user', role: 'user', origin: 'lite', content: '继续刚才的读书计划', createdAt: 2000 }]);
  let stored = { brain_id: 'primary', char_id: 'c', source_device_id: 'a', source_device_name: '设备 A', revision: 1, updated_at: 1000,
    prompt: '现在是2026年10月8日15时30分，我刚才在讨论读书计划，接下来要进行迁移。',
    messages: [{ id: 'old', role: 'assistant', origin: 'main', content: '先读第一章', createdAt: 1000 }] };
  const requests: Array<{ url: string; method: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: String(url), method: init?.method || 'GET', body });
    if (String(url).includes('/chat/completions')) return Response.json({ choices: [{ message: { content: body.messages.at(-1).content.includes('跨设备迁移总结') ? '现在是2026年10月8日15时32分，我刚才在继续读书，接下来要进行迁移。' : '我们继续第一章。' } }] });
    if (init?.method === 'POST') stored = body;
    return Response.json([stored]);
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const mount = async () => { root = createRoot(host); await act(async () => { root!.render(createElement(LiteApp)); }); };
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
    expect(button, `button ${text}`).toBeTruthy();
    await act(async () => { button!.click(); });
  };
  await mount();
  expect(host.querySelector('.handoff-label')?.textContent).toContain('以下消息接收自 设备 A · 接收于 设备 B');
  expect(host.querySelector('.handoff-label')?.getAttribute('title')).toContain(stored.prompt);
  const readsBeforeReply = requests.filter(r => r.method === 'GET').length;
  await click('生成回复');
  expect(requests.filter(r => r.method === 'GET')).toHaveLength(readsBeforeReply);
  const reply = requests.find(r => r.url.includes('/chat/completions'))!;
  expect(JSON.stringify(reply.body.messages)).toContain(stored.prompt);
  expect(JSON.stringify(reply.body.messages)).toContain('现在已迁移至 设备 B 继续对话');

  await click('打开功能菜单');
  await click('向量记忆');
  await click('同步近期上下文');
  expect(host.querySelector('[aria-label="迁移总结"]')).toBeTruthy();
  expect(requests.filter(r => r.method === 'POST' && r.url.includes('shared_recent_contexts'))).toHaveLength(0);
  await click('取消');
  expect(host.querySelector('[aria-label="迁移总结"]')).toBeNull();
  await click('同步近期上下文');
  await click('确认并上传');
  expect(requests.filter(r => r.method === 'POST' && r.url.includes('shared_recent_contexts'))).toHaveLength(1);
  expect(stored.messages.some((m: any) => m.handoffSummary?.includes('我刚才在继续读书'))).toBe(true);
  expect([...host.querySelectorAll('.handoff-label')].some(p => p.textContent?.includes('上传于 设备 B'))).toBe(true);
  expect(host.textContent).toContain('已发布来自 设备 B');
  expect(host.textContent).not.toMatch(/已发布第.*版/);

  await act(async () => root!.unmount());
  root = undefined;
  await mount();
  expect([...host.querySelectorAll('.handoff-label')].filter(p => p.textContent?.includes('接收自 设备 A'))).toHaveLength(1);
  expect(host.textContent).toContain('先读第一章');
});
