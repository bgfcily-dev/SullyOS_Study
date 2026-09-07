/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_LITE_DEFAULT_PROMPT } from './prompts';
import { loadApiProfiles, loadCloudConfig, loadEmbeddingConfig, loadIdentity, parseLiteStickerText, saveTheme } from './storage';

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
});
