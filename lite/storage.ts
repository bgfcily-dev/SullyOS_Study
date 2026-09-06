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
  theme: 'sully_lite_theme_v1',
};

const createDeviceId = (): string => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const loadDeviceId = (): string => {
  const saved = localStorage.getItem(KEYS.deviceId)?.trim();
  if (saved) return saved;
  const next = createDeviceId();
  localStorage.setItem(KEYS.deviceId, next);
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
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : undefined;
  } catch {
    return undefined;
  }
};

const cleanApi = (value: Partial<LiteApiProfile>): LiteApiProfile => ({
  id: String(value.id || `api-${Date.now()}`),
  name: String(value.name || '未命名 API').trim() || '未命名 API',
  baseUrl: String(value.baseUrl || '').trim().replace(/\/+$/, ''),
  apiKey: String(value.apiKey || '').trim(),
  model: String(value.model || '').trim(),
});

export function loadApiProfiles(): LiteApiProfile[] {
  const saved = readJson<LiteApiProfile[]>(KEYS.apiProfiles);
  if (Array.isArray(saved) && saved.length > 0) return saved.map(cleanApi);

  const fullPresets = readJson<Array<{ id?: string; name?: string; config?: Record<string, unknown> }>>('os_api_presets');
  const imported = Array.isArray(fullPresets)
    ? fullPresets.map((preset) => cleanApi({
      id: preset.id,
      name: preset.name,
      baseUrl: String(preset.config?.baseUrl || ''),
      apiKey: String(preset.config?.apiKey || ''),
      model: String(preset.config?.model || ''),
    })).filter((profile) => profile.baseUrl || profile.model)
    : [];
  if (imported.length > 0) return imported;

  const fullApi = readJson<Record<string, unknown>>('os_api_config');
  if (fullApi?.baseUrl || fullApi?.model) {
    return [cleanApi({
      id: 'imported-main',
      name: 'SullyOS 主 API',
      baseUrl: String(fullApi.baseUrl || ''),
      apiKey: String(fullApi.apiKey || ''),
      model: String(fullApi.model || ''),
    })];
  }
  return [fallbackApi()];
}

export function loadOriginalApiProfiles(): LiteApiProfile[] {
  const fullPresets = readJson<Array<{ id?: string; name?: string; config?: Record<string, unknown> }>>('os_api_presets');
  const current = readJson<Record<string, unknown>>('os_api_config');
  const profiles: LiteApiProfile[] = [];

  if (current?.baseUrl || current?.apiKey || current?.model) {
    profiles.push(cleanApi({
      id: 'original-main',
      name: '原版当前 API',
      baseUrl: String(current.baseUrl || ''),
      apiKey: String(current.apiKey || ''),
      model: String(current.model || ''),
    }));
  }

  if (Array.isArray(fullPresets)) {
    for (const preset of fullPresets) {
      const config = preset.config || {};
      if (!config.baseUrl && !config.apiKey && !config.model) continue;
      profiles.push(cleanApi({
        id: `original-preset-${preset.id || profiles.length}`,
        name: `原版 · ${String(preset.name || 'API 预设')}`,
        baseUrl: String(config.baseUrl || ''),
        apiKey: String(config.apiKey || ''),
        model: String(config.model || ''),
      }));
    }
  }

  const seen = new Set<string>();
  return profiles.filter((profile) => {
    const signature = `${profile.baseUrl}\n${profile.apiKey}\n${profile.model}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export function saveApiProfiles(profiles: LiteApiProfile[], activeId: string): void {
  localStorage.setItem(KEYS.apiProfiles, JSON.stringify(profiles.map(cleanApi)));
  localStorage.setItem(KEYS.activeApiId, activeId);
}

export function loadActiveApiId(profiles: LiteApiProfile[]): string {
  const saved = localStorage.getItem(KEYS.activeApiId);
  return profiles.some((profile) => profile.id === saved) ? saved! : profiles[0]?.id || 'default';
}

export function loadIdentity(): LiteIdentity {
  const saved = readJson<Partial<LiteIdentity>>(KEYS.identity);
  const savedPrompt = String(saved?.systemPrompt || '').trim();
  return {
    characterName: String(saved?.characterName || 'Sully'),
    userName: String(saved?.userName || 'TA'),
    systemPrompt: !savedPrompt || savedPrompt === LEGACY_LITE_DEFAULT_PROMPT || savedPrompt === LEGACY_LITE_ROLE_PRESET_TEMPLATE
      ? LITE_ROLE_PRESET_TEMPLATE
      : savedPrompt,
  };
}

export function saveIdentity(identity: LiteIdentity): void {
  localStorage.setItem(KEYS.identity, JSON.stringify(identity));
}

export function loadCloudConfig(): LiteCloudConfig {
  const saved = readJson<Partial<LiteCloudConfig>>(KEYS.cloud);
  const fullConfig = readJson<Record<string, unknown>>('os_remote_vector_config');
  return {
    supabaseUrl: String(saved?.supabaseUrl || fullConfig?.supabaseUrl || '').trim().replace(/\/+$/, ''),
    supabaseAnonKey: String(saved?.supabaseAnonKey || fullConfig?.supabaseAnonKey || '').trim(),
    deviceId: String(saved?.deviceId || loadDeviceId()).trim(),
    deviceName: String(saved?.deviceName || '轻量设备').trim() || '轻量设备',
  };
}

export function saveCloudConfig(config: LiteCloudConfig): void {
  localStorage.setItem(KEYS.cloud, JSON.stringify({
    ...config,
    supabaseUrl: config.supabaseUrl.trim().replace(/\/+$/, ''),
    supabaseAnonKey: config.supabaseAnonKey.trim(),
    deviceId: config.deviceId.trim() || loadDeviceId(),
    deviceName: config.deviceName.trim() || '轻量设备',
  }));
}

export function loadEmbeddingConfig(): LiteEmbeddingConfig {
  const saved = readJson<Partial<LiteEmbeddingConfig>>(KEYS.embedding);
  const fullConfig = readJson<{ embedding?: Partial<LiteEmbeddingConfig> }>('os_memory_palace_config');
  const imported = fullConfig?.embedding;
  const baseUrl = String(saved?.baseUrl || imported?.baseUrl || 'https://api.siliconflow.cn/v1').trim().replace(/\/+$/, '');
  const apiKey = String(saved?.apiKey || imported?.apiKey || '').trim();
  const model = String(saved?.model || imported?.model || 'BAAI/bge-m3').trim();
  const dimensions = Number(saved?.dimensions || imported?.dimensions || 1024);
  return {
    enabled: saved?.enabled ?? Boolean(apiKey && model),
    baseUrl,
    apiKey,
    model,
    dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : 1024,
  };
}

export function saveEmbeddingConfig(config: LiteEmbeddingConfig): void {
  localStorage.setItem(KEYS.embedding, JSON.stringify({
    ...config,
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
    dimensions: Number.isFinite(config.dimensions) && config.dimensions > 0 ? config.dimensions : 1024,
  }));
}

export function loadOriginalMemorySettings(): {
  cloud?: Pick<LiteCloudConfig, 'supabaseUrl' | 'supabaseAnonKey'>;
  embedding?: LiteEmbeddingConfig;
} {
  const remote = readJson<Record<string, unknown>>('os_remote_vector_config');
  const memoryPalace = readJson<{ embedding?: Partial<LiteEmbeddingConfig> }>('os_memory_palace_config');
  const embedding = memoryPalace?.embedding;
  const supabaseUrl = String(remote?.supabaseUrl || '').trim().replace(/\/+$/, '');
  const supabaseAnonKey = String(remote?.supabaseAnonKey || '').trim();
  const baseUrl = String(embedding?.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(embedding?.apiKey || '').trim();
  const model = String(embedding?.model || '').trim();
  const dimensions = Number(embedding?.dimensions || 1024);

  return {
    cloud: supabaseUrl || supabaseAnonKey ? { supabaseUrl, supabaseAnonKey } : undefined,
    embedding: baseUrl || apiKey || model ? {
      enabled: Boolean(apiKey && model),
      baseUrl: baseUrl || 'https://api.siliconflow.cn/v1',
      apiKey,
      model: model || 'BAAI/bge-m3',
      dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : 1024,
    } : undefined,
  };
}

export function loadTheme(): LiteTheme {
  const saved = localStorage.getItem(KEYS.theme);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function saveTheme(theme: LiteTheme): void {
  localStorage.setItem(KEYS.theme, theme);
}

export function loadLocalMessages(): LiteMessage[] {
  return normalizeMessages(readJson<unknown>(KEYS.messages)).slice(-LOCAL_MESSAGE_LIMIT);
}

export function saveLocalMessages(messages: LiteMessage[]): void {
  localStorage.setItem(KEYS.messages, JSON.stringify(messages.slice(-LOCAL_MESSAGE_LIMIT)));
}
