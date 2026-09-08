import { describe, expect, it } from 'vitest';
import { parseLiteMemoryDrafts, parseLiteSyncedMemoryRows } from './memoryTools';

describe('Sully Lite memory extraction parsing', () => {
  it('accepts fenced JSON and normalizes unsafe fields', () => {
    const result = parseLiteMemoryDrafts('```json\n[{"content":" 记住这件事 ","room":"bad","importance":99,"mood":"tender","tags":["一","",2]}]\n```');
    expect(result).toEqual([{ content: '记住这件事', room: 'living_room', importance: 10, mood: 'tender', tags: ['一'] }]);
  });

  it('reports invalid model output', () => {
    expect(() => parseLiteMemoryDrafts('我无法输出 JSON')).toThrow('不是有效的 JSON');
  });
});

describe('Sully Lite synced memory parsing', () => {
  it('keeps only Lite-uploaded rows and normalizes their metadata', () => {
    const result = parseLiteSyncedMemoryRows([
      { memory_id: 'lite_ctx_abc_0', char_id: 'char-1', content: ' 一条记忆 ', room: 'study', importance: 12, tags: ['学习'], model: 'bge-m3', dimensions: 1024, created_at: '123', archived: false },
      { memory_id: 'original_1', char_id: 'char-1', content: '原版记忆' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ memoryId: 'lite_ctx_abc_0', content: '一条记忆', room: 'study', importance: 10, dimensions: 1024 });
  });
});
