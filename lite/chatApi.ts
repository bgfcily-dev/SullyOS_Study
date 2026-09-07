import type { LiteApiProfile, LiteIdentity, LiteMemoryRecall, LiteMessage, SharedRecentContext } from './types';
import { mergeMessageHistory } from './context';
import { buildLiteBuiltinChatPrompt, buildLiteRoleContext, buildLiteTimeAwarenessPrompt, formatLiteMessageTime } from './prompts';

export function liteChatUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  return clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
}

export function extractLiteText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const item = part as Record<string, unknown>;
      return extractLiteText(item.text ?? item.content ?? item.value);
    }).join('');
  }
  return '';
}

export async function testLiteChatConnection(api: LiteApiProfile): Promise<string> {
  if (!api.baseUrl.trim() || !api.apiKey.trim() || !api.model.trim()) {
    throw new Error('请先填写完整的 API 地址、密钥和模型');
  }
  let response: Response;
  try {
    response = await fetch(liteChatUrl(api.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: api.model.trim(),
        stream: false,
        max_tokens: 3,
        messages: [{ role: 'user', content: '只回复 OK' }],
      }),
    });
  } catch {
    throw new Error('无法连接聊天 API，请检查地址、网络和网页跨域权限');
  }
  const raw = await response.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* status is still authoritative */ }
  if (!response.ok) {
    const detail = extractLiteText(data?.error?.message ?? data?.error) || raw.slice(0, 160);
    throw new Error(`聊天 API 测试失败（${response.status}）：${detail || '未知错误'}`);
  }
  return `连接成功：模型 ${api.model.trim()} 可用`;
}

export async function requestLiteReply(input: {
  api: LiteApiProfile;
  identity: LiteIdentity;
  cloudContext: SharedRecentContext | null;
  localMessages: LiteMessage[];
  memories?: LiteMemoryRecall[];
  signal?: AbortSignal;
}): Promise<string> {
  const { api, cloudContext, localMessages } = input;
  if (!api.baseUrl || !api.apiKey || !api.model) throw new Error('请先在设置中填写当前 API 的地址、密钥和模型');

  const identity = input.identity;
  const history = mergeMessageHistory(cloudContext?.messages || [], localMessages, 50);
  const memoryText = input.memories?.length
    ? `### 记忆宫殿\n以下内容是与本轮话题相关的既有记忆。只在相关时自然影响回复，不要逐条复述，也不要向用户解释检索过程。\n${input.memories.map((memory) => `- **[${memory.room || '记忆'}]**（重要性 ${memory.importance}）：${memory.content}`).join('\n')}`
    : '';
  const systemText = [
    buildLiteRoleContext(identity),
    buildLiteBuiltinChatPrompt(),
    `你现在以「${identity.characterName}」的身份和「${identity.userName}」继续同一段跨设备对话。`,
    cloudContext
      ? '下面的聊天历史可能来自另一台设备。把它当作自己亲历的最近对话，自然接续；不要向用户解释同步、云端或上下文注入。'
      : '',
    memoryText,
  ].filter(Boolean).join('\n\n');
  const modelHistory = history.map((message) => ({
    role: message.role,
    content: `[${formatLiteMessageTime(message.createdAt)}] ${message.content}`,
  }));
  const latestMessage = modelHistory.pop();
  const liveTimeText = buildLiteTimeAwarenessPrompt(new Date(), history);

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 120_000);
  const abortForwarder = () => controller.abort();
  input.signal?.addEventListener('abort', abortForwarder, { once: true });
  try {
    const response = await fetch(liteChatUrl(api.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api.apiKey}`,
      },
      body: JSON.stringify({
        model: api.model,
        stream: false,
        messages: [
          { role: 'system', content: systemText },
          ...modelHistory,
          { role: 'system', content: liveTimeText },
          ...(latestMessage ? [latestMessage] : []),
        ],
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data: any;
    try { data = JSON.parse(raw); } catch {
      throw new Error(`API 返回的不是 JSON：${raw.slice(0, 120) || '空响应'}`);
    }
    if (!response.ok) {
      const detail = extractLiteText(data?.error?.message ?? data?.error) || raw.slice(0, 160);
      throw new Error(`API 请求失败（${response.status}）：${detail}`);
    }
    const message = data?.choices?.[0]?.message;
    let text = extractLiteText(message?.content);
    if (!text.trim()) text = extractLiteText(message?.reasoning_content);
    text = text.replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '').trim();
    if (!text) throw new Error('API 返回成功，但没有找到回复正文');
    return text;
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('等待回复超过两分钟，已停止本次请求');
    if (error?.name === 'TypeError') throw new Error('无法连接聊天 API，请检查地址、网络以及服务是否允许网页跨域访问');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abortForwarder);
  }
}
