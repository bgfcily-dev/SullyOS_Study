import type { LiteApiProfile, LiteCloudConfig, LiteEmbeddingConfig, LiteIdentity, LiteMessage, LiteTheme } from './types';
import { LOCAL_MESSAGE_LIMIT, normalizeMessages } from './context';
import { LEGACY_LITE_DEFAULT_PROMPT, LEGACY_LITE_ROLE_PRESET_TEMPLATE, LITE_ROLE_PRESET_TEMPLATE } from './prompts';

const KEYS = {
  apiProfiles: 'sully_lite_api_profiles_v1',
  activeApiId: 'sully_lite_active_api_v1',
  cloud: 'sully_lite_cloud_v1',
  deviceId: 'sully_lite_device_id_v1',
  embedding: 'sully_lite_embedding_v1',
  identity: 'sully_lite_identity_v1',
  messages: 'sully_lite_messages_v1',
  fontSize: 'sully_lite_font_size_v1',
  theme: 'sully_lite_theme_v1',
};

const createDeviceId = (): string => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const safeGetItem = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeSetItem = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Some Android browsers disable or exhaust localStorage. The page should
    // remain usable for the current session instead of crashing to a white screen.
  }
};

const loadDeviceId = (): string => {
  const saved = safeGetItem(KEYS.deviceId)?.trim();
  if (saved) return saved;
  const next = createDeviceId();
  safeSetItem(KEYS.deviceId, next);
  return next;
};

const fallbackApi = (): LiteApiProfile => ({
  id: 'default',
  name: '默认 API',
  baseUrl: '',
  apiKey: '',
  model: '',
});

const readJson = <T,>(key: string): T | undefined => {
  try {
    const raw = safeGetItem(key);
    return raw ? JSON.parse(raw) as T : undefined;
  } catch {
    return undefined;
  }
};

const cleanApi = (value: Partial<LiteApiProfile> | null | undefined): LiteApiProfile => {
  const source = value && typeof value === 'object' ? value : {};
  return {
    id: String(source.id || `api-${Date.now()}`),
    name: String(source.name || '未命名 API').trim() || '未命名 API',
    baseUrl: String(source.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(source.apiKey || '').trim(),
    model: String(source.model || '').trim(),
  };
};

export function loadApiProfiles(): LiteApiProfile[] {
  const saved = readJson<LiteApiProfile[]>(KEYS.apiProfiles);
  if (Array.isArray(saved) && saved.length > 0) return saved.map(cleanApi);
  return [fallbackApi()];
}

export function saveApiProfiles(profiles: LiteApiProfile[], activeId: string): void {
  safeSetItem(KEYS.apiProfiles, JSON.stringify(profiles.map(cleanApi)));
  safeSetItem(KEYS.activeApiId, activeId);
}

export function loadActiveApiId(profiles: LiteApiProfile[]): string {
  const saved = safeGetItem(KEYS.activeApiId);
  return profiles.some((profile) => profile.id === saved) ? saved! : profiles[0]?.id || 'default';
}

export function loadIdentity(): LiteIdentity {
  const saved = readJson<Partial<LiteIdentity>>(KEYS.identity);
  const savedPrompt = String(saved?.systemPrompt || '').trim();
  const isBundledPlaceholder = !savedPrompt
    || savedPrompt === LEGACY_LITE_DEFAULT_PROMPT
    || savedPrompt === LEGACY_LITE_ROLE_PRESET_TEMPLATE
    || savedPrompt === LITE_ROLE_PRESET_TEMPLATE;
  return {
    characterName: String(saved?.characterName || 'Sully'),
    characterAvatar: String(saved?.characterAvatar || ''),
    userName: String(saved?.userName || 'TA'),
    userPrompt: String(saved?.userPrompt || ''),
    systemPrompt: isBundledPlaceholder ? '' : savedPrompt,
  };
}

export function saveIdentity(identity: LiteIdentity): void {
  safeSetItem(KEYS.identity, JSON.stringify(identity));
}

export function loadCloudConfig(): LiteCloudConfig {
  const saved = readJson<Partial<LiteCloudConfig>>(KEYS.cloud);
  return {
    supabaseUrl: String(saved?.supabaseUrl || '').trim().replace(/\/+$/, ''),
    supabaseAnonKey: String(saved?.supabaseAnonKey || '').trim(),
    deviceId: String(saved?.deviceId || loadDeviceId()).trim(),
    deviceName: String(saved?.deviceName || '轻量设备').trim() || '轻量设备',
  };
}

export function saveCloudConfig(config: LiteCloudConfig): void {
  safeSetItem(KEYS.cloud, JSON.stringify({
    ...config,
    supabaseUrl: config.supabaseUrl.trim().replace(/\/+$/, ''),
    supabaseAnonKey: config.supabaseAnonKey.trim(),
    deviceId: config.deviceId.trim() || loadDeviceId(),
    deviceName: config.deviceName.trim() || '轻量设备',
  }));
}

export function loadEmbeddingConfig(): LiteEmbeddingConfig {
  const saved = readJson<Partial<LiteEmbeddingConfig>>(KEYS.embedding);
  const baseUrl = String(saved?.baseUrl || 'https://api.siliconflow.cn/v1').trim().replace(/\/+$/, '');
  const apiKey = String(saved?.apiKey || '').trim();
  const model = String(saved?.model || 'BAAI/bge-m3').trim();
  const dimensions = Number(saved?.dimensions || 1024);
  return {
    enabled: saved?.enabled ?? false,
    baseUrl,
    apiKey,
    model,
    dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : 1024,
  };
}

export function saveEmbeddingConfig(config: LiteEmbeddingConfig): void {
  safeSetItem(KEYS.embedding, JSON.stringify({
    ...config,
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
    dimensions: Number.isFinite(config.dimensions) && config.dimensions > 0 ? config.dimensions : 1024,
  }));
}

export function loadTheme(): LiteTheme {
  const saved = safeGetItem(KEYS.theme);
  if (saved === 'light' || saved === 'dark') return saved;
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function saveTheme(theme: LiteTheme): void {
  safeSetItem(KEYS.theme, theme);
}

export function loadFontSize(): number {
  const saved = Number(safeGetItem(KEYS.fontSize));
  return Number.isFinite(saved) && saved >= 12 && saved <= 20 ? saved : 14;
}

export function saveFontSize(size: number): void {
  safeSetItem(KEYS.fontSize, String(Math.min(20, Math.max(12, Math.round(size)))));
}

export function loadLocalMessages(): LiteMessage[] {
  return normalizeMessages(readJson<unknown>(KEYS.messages)).slice(-LOCAL_MESSAGE_LIMIT);
}

export function saveLocalMessages(messages: LiteMessage[]): void {
  safeSetItem(KEYS.messages, JSON.stringify(messages.slice(-LOCAL_MESSAGE_LIMIT)));
}
