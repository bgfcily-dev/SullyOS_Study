import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOriginalApiProfiles, loadOriginalMemorySettings } from './storage';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('Sully Lite original settings import', () => {
  beforeEach(() => vi.stubGlobal('localStorage', new MemoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('imports the original current chat API including its key', () => {
    localStorage.setItem('os_api_config', JSON.stringify({
      baseUrl: 'https://chat.example/v1',
      apiKey: 'chat-secret',
      model: 'chat-model',
    }));
    const profiles = loadOriginalApiProfiles();
    expect(profiles[0]).toMatchObject({ apiKey: 'chat-secret', model: 'chat-model' });
  });

  it('imports Supabase and Embedding keys independently', () => {
    localStorage.setItem('os_remote_vector_config', JSON.stringify({
      supabaseUrl: 'https://memory.supabase.co',
      supabaseAnonKey: 'supabase-secret',
    }));
    localStorage.setItem('os_memory_palace_config', JSON.stringify({
      embedding: { baseUrl: 'https://embed.example/v1', apiKey: 'embed-secret', model: 'embed-model', dimensions: 1024 },
    }));
    const settings = loadOriginalMemorySettings();
    expect(settings.cloud?.supabaseAnonKey).toBe('supabase-secret');
    expect(settings.embedding?.apiKey).toBe('embed-secret');
  });
});
