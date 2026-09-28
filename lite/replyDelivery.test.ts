import { describe, expect, it } from 'vitest';
import { getCurrentTurnReplyIds, getLiteReplyDelay } from './replyDelivery';
import type { LiteMessage } from './types';

const message = (id: string, role: LiteMessage['role']): LiteMessage => ({
  id,
  role,
  content: id,
  createdAt: 1,
  origin: 'lite',
});

describe('Sully Lite reply delivery', () => {
  it('selects only assistant bubbles after the latest user message', () => {
    const messages = [
      message('u1', 'user'),
      message('a1', 'assistant'),
      message('u2', 'user'),
      message('a2', 'assistant'),
      message('a3', 'assistant'),
    ];
    expect(getCurrentTurnReplyIds(messages)).toEqual(['a2', 'a3']);
  });

  it('has bounded pauses and disables them for reduced motion', () => {
    expect(getLiteReplyDelay({ kind: 'text', content: '好' })).toBe(300);
    expect(getLiteReplyDelay({ kind: 'text', content: '很长'.repeat(100) })).toBe(900);
    expect(getLiteReplyDelay({ kind: 'sticker', name: '抱抱' })).toBe(420);
    expect(getLiteReplyDelay({ kind: 'text', content: '任意长度' }, true)).toBe(0);
  });
});
