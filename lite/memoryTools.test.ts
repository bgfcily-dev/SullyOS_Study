import { describe, expect, it } from 'vitest';
import { parseLiteMemoryDrafts } from './memoryTools';

describe('Sully Lite memory extraction parsing', () => {
  it('accepts fenced JSON and normalizes unsafe fields', () => {
    const result = parseLiteMemoryDrafts('```json\n[{"content":" 记住这件事 ","room":"bad","importance":99,"mood":"tender","tags":["一","",2]}]\n```');
    expect(result).toEqual([{ content: '记住这件事', room: 'living_room', importance: 10, mood: 'tender', tags: ['一'] }]);
  });

  it('reports invalid model output', () => {
    expect(() => parseLiteMemoryDrafts('我无法输出 JSON')).toThrow('不是有效的 JSON');
  });
});
