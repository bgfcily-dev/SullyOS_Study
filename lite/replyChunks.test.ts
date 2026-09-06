import { describe, expect, it } from 'vitest';
import { splitLiteReply } from './replyChunks';

describe('Sully Lite reply bubbles', () => {
  it('splits Chinese sentences even when the model returns one paragraph', () => {
    expect(splitLiteReply('第一句。第二句！第三句？')).toEqual(['第一句。', '第二句！', '第三句？']);
  });

  it('keeps closing quotation marks with their sentence', () => {
    expect(splitLiteReply('“好。”她又补了一句。')).toEqual(['“好。”', '她又补了一句。']);
  });

  it('honors explicit newlines and caps excessive bubbles', () => {
    expect(splitLiteReply('a\nb\nc\nd', 3)).toEqual(['a', 'b', 'cd']);
  });
});
