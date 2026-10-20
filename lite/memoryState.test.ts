import { afterEach, expect, it, vi } from 'vitest';
import { resolveMemoryState, formatMemoryContext } from './memoryState';
import type { LiteMemoryRecall } from './types';
const cloud = { supabaseUrl: 'https://sync.test', supabaseAnonKey: 'key', deviceId: 'd', deviceName: 'd' };
const item = (id: string, kind?: 'event' | 'reflection' | 'identity', extra = {}): LiteMemoryRecall => ({ memoryId: id, content: id, room: '', importance: 5, similarity: 1, metadata: kind ? { kind, status: 'active', ...extra } : undefined });
afterEach(() => vi.unstubAllGlobals());
it('replaces a highly similar old reflection with its current state and event', async () => {
  const event = item('event', 'event', { current_reflection_id: 'new' });
  const latest = item('new', 'reflection', { event_id: 'event' });
  const mock = vi.fn(async (url: string) => { const id = new URL(url).searchParams.get('memory_id')?.slice(3); const value = id === 'event' ? event : latest; return Response.json([{ ...value, memory_id: value.memoryId, char_id: 'c' }]); });
  vi.stubGlobal('fetch', mock);
  expect((await resolveMemoryState([item('old', 'reflection', { event_id: 'event' })], cloud, 'c')).map(value => value.memoryId)).toEqual(['event', 'new']);
  expect(mock).toHaveBeenCalledTimes(2);
});
it('isolates identity and pending states while retaining unclassified records', async () => {
  const values = [item('legacy'), item('identity', 'identity'), item('pending', 'event', { status: 'pending' })];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
  expect((await resolveMemoryState(values, cloud, 'c')).map(value => value.memoryId)).toEqual(['legacy']);
  expect((await resolveMemoryState(values, cloud, 'c', true)).map(value => value.memoryId)).toEqual(['legacy', 'identity']);
});
it('rejects wrong-role, wrong-event and archived relationships', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const id = new URL(url).searchParams.get('memory_id')?.slice(3);
    return Response.json(id === 'event' ? [{ memory_id: 'event', char_id: 'c', content: '事实', metadata: { kind: 'event', current_reflection_id: 'bad' } }] : [{ memory_id: 'bad', char_id: 'other', content: 'wrong', metadata: { kind: 'reflection', event_id: 'event' } }]);
  }));
  expect((await resolveMemoryState([item('old', 'reflection', { event_id: 'event' })], cloud, 'c')).map(value => value.memoryId)).toEqual(['event']);
});
it('fails visibly instead of falling back to stale reflections', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  await expect(resolveMemoryState([item('old', 'reflection', { event_id: 'event' })], cloud, 'c')).rejects.toThrow('核对');
});
it('labels subjective content, uncertainty and legacy records in model context', () => {
  const text = formatMemoryContext([item('r', 'reflection', { event_id: 'e', confidence: 0.45 }), item('legacy')]);
  expect(text).toContain('当前感想'); expect(text).toContain('旧未分类记录'); expect(text).toContain('0.45'); expect(text).toContain('不证明他人的动机');
});
