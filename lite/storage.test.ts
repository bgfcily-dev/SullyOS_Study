/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_LITE_DEFAULT_PROMPT } from './prompts';
import { formatLiteStickerText, loadApiProfiles, loadChatBackground, loadCloudConfig, loadDeletedMessageIds, loadEmbeddingConfig, loadIdentity, loadMemorySummaryApi, parseLiteStickerText, saveChatBackground, saveDeletedMessageIds, saveMemorySummaryApi, saveTheme } from './storage';

describe('Sully Lite storage isolation', () => {
  beforeEach(() => localStorage.clear());

  it('does not silently import the original app API or memory settings', () => {
    localStorage.setItem('os_api_config', JSON.stringify({ baseUrl: 'https://private.example/v1', apiKey: 'secret', model: 'hidden' }));
    localStorage.setItem('os_remote_vector_config', JSON.stringify({ supabaseUrl: 'https://memory.example', supabaseAnonKey: 'memory-key' }));
    localStorage.setItem('os_memory_palace_config', JSON.stringify({ enabled: true, apiKey: 'embedding-key' }));

    expect(loadApiProfiles()[0]).toMatchObject({ baseUrl: '', apiKey: '', model: '' });
    expect(loadCloudConfig()).toMatchObject({ supabaseUrl: '', supabaseAnonKey: '' });
    expect(loadEmbeddingConfig()).toMatchObject({ enabled: false, apiKey: '' });
  });

  it('migrates the old bundled placeholder into empty editable presets', () => {
    localStorage.setItem('sully_lite_identity_v1', JSON.stringify({
      characterName: '小树',
      userName: '小雨',
      systemPrompt: LEGACY_LITE_DEFAULT_PROMPT,
    }));

    expect(loadIdentity()).toEqual({
      characterName: '小树',
      characterAvatar: '',
      userName: '小雨',
      userPrompt: '',
      systemPrompt: '',
    });
  });

  it('does not crash when Android blocks or exhausts local storage', () => {
    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => loadApiProfiles()).not.toThrow();
    getSpy.mockRestore();

    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => saveTheme('dark')).not.toThrow();
    setSpy.mockRestore();
  });

  it('parses sticker lines without splitting the protocol colon', () => {
    expect(parseLiteStickerText('开心：https://img.example/a.png\n抱抱: https://img.example/b.gif\n无效行')).toEqual([
      { name: '开心', url: 'https://img.example/a.png' },
      { name: '抱抱', url: 'https://img.example/b.gif' },
    ]);
  });

  it('serializes edited stickers back to the documented colon format', () => {
    expect(formatLiteStickerText([{ name: '开心', url: 'https://img.example/a.png' }])).toBe('开心：https://img.example/a.png');
  });

  it('keeps the optional memory-summary API separate from the chat API', () => {
    saveMemorySummaryApi({ baseUrl: 'https://cheap.example/v1/', apiKey: 'memory-key', model: 'cheap-model' });
    expect(loadMemorySummaryApi()).toEqual({ baseUrl: 'https://cheap.example/v1', apiKey: 'memory-key', model: 'cheap-model' });
    expect(loadApiProfiles()[0]).toMatchObject({ baseUrl: '', apiKey: '', model: '' });
  });

  it('stores the custom chat background only in Lite local storage', () => {
    saveChatBackground('data:image/jpeg;base64,abc');
    expect(loadChatBackground()).toBe('data:image/jpeg;base64,abc');
  });

  it('stores unique deleted message ids for cloud-message overrides', () => {
    saveDeletedMessageIds(['cloud-1', 'cloud-1', 'lite-2']);
    expect(loadDeletedMessageIds()).toEqual(['cloud-1', 'lite-2']);
  });
});
