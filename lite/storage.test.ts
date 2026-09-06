/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_LITE_DEFAULT_PROMPT } from './prompts';
import { loadApiProfiles, loadCloudConfig, loadEmbeddingConfig, loadIdentity } from './storage';

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
});
