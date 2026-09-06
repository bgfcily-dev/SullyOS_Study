import { describe, expect, it } from 'vitest';
import { mergeMessageHistory, parseSharedContextRow } from './context';
import type { LiteMessage } from './types';

const message = (id: string, createdAt: number, content = id): LiteMessage => ({ id, createdAt, content, role: 'user', origin: 'lite' });

describe('Sully Lite shared context', () => {
  it('merges shared and local history in time order without duplicates', () => {
    const result = mergeMessageHistory(
      [message('a', 1), message('b', 2, 'cloud copy')],
      [message('b', 2, 'local copy'), message('c', 3)],
      30,
    );
    expect(result.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(result[1].content).toBe('local copy');
  });

  it('keeps only the newest requested number of messages', () => {
    const result = mergeMessageHistory([], [message('a', 1), message('b', 2), message('c', 3)], 2);
    expect(result.map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('normalizes the single primary brain row', () => {
    const result = parseSharedContextRow({
      char_id: 'char-real-one',
      messages: [message('a', 1), { bad: true }],
      source_device_id: 'device-a',
      source_device_name: '主设备',
      revision: '4',
      updated_at: '100',
    });
    expect(result.brainId).toBe('primary');
    expect(result.charId).toBe('char-real-one');
    expect(result.sourceDeviceName).toBe('主设备');
    expect(result.messages).toHaveLength(1);
    expect(result.revision).toBe(4);
    expect(result.updatedAt).toBe(100);
  });

  it('accepts legacy lite messages without an origin marker', () => {
    const result = parseSharedContextRow({ messages: [{ id: 'legacy', role: 'assistant', content: '旧消息', createdAt: 10 }] });
    expect(result.messages[0].origin).toBe('lite');
  });
});
