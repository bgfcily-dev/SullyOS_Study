import { extractModelIds } from '../utils/modelList';
import type { LiteApiProfile } from './types';

export function liteModelsUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  if (clean.endsWith('/chat/completions')) return `${clean.slice(0, -'/chat/completions'.length)}/models`;
  if (clean.endsWith('/models')) return clean;
  return `${clean}/models`;
}

export async function fetchLiteModels(api: LiteApiProfile): Promise<string[]> {
  if (!api.baseUrl.trim()) throw new Error('请先填写 API 地址');
  if (!api.apiKey.trim()) throw new Error('请先填写 API Key');

  let response: Response;
  try {
    response = await fetch(liteModelsUrl(api.baseUrl), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${api.apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
    });
  } catch {
    throw new Error('无法连接模型接口，请检查地址、网络和网页跨域权限');
  }

  const raw = await response.text();
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!response.ok) {
    const record = data && typeof data === 'object' ? data as Record<string, any> : {};
    const message = String(record.error?.message || record.message || '').trim();
    throw new Error(`模型接口返回 HTTP ${response.status}${message ? `：${message}` : ''}`);
  }

  const models = extractModelIds(data);
  if (models.length === 0) throw new Error('接口连接成功，但没有找到可用的模型列表');
  return models;
}
