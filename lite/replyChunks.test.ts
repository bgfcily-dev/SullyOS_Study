import { describe, expect, it } from 'vitest';
import { splitLiteReply, splitLiteReplyParts } from './replyChunks';

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

  it('turns original SEND_EMOJI commands into ordered sticker bubbles', () => {
    expect(splitLiteReplyParts('先给你一个。[[SEND_EMOJI: 抱抱]]\n好一点了吗？', ['抱抱'])).toEqual([
      { kind: 'text', content: '先给你一个。' },
      { kind: 'sticker', name: '抱抱' },
      { kind: 'text', content: '好一点了吗？' },
    ]);
  });

  it('accepts a full-width colon and keeps unknown commands readable', () => {
    expect(splitLiteReplyParts('[[SEND_EMOJI：开心]][[SEND_EMOJI: 不存在]]', ['开心'])).toEqual([
      { kind: 'sticker', name: '开心' },
      { kind: 'text', content: '[表情包：不存在]' },
    ]);
  });
});
