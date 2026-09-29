import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishSharedContext } from './recentContextHandoff';

afterEach(() => vi.unstubAllGlobals());

describe('role ID handoff', () => {
  it('can publish the current character ID before there are recent messages', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      new Response(String(init.body), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishSharedContext({
      config: { supabaseUrl: 'https://memory.example', supabaseAnonKey: 'key', deviceId: 'main', deviceName: '原版' },
      charId: 'char-real-one', sharedMessages: [], localMessages: [], allowEmptyMessages: true,
    });
    expect(result.charId).toBe('char-real-one');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).char_id).toBe('char-real-one');
  });
});
