import type { LiteReplyPart } from './replyChunks';
import type { LiteMessage } from './types';

/** Return every assistant bubble that belongs to the latest user turn. */
export function getCurrentTurnReplyIds(messages: readonly LiteMessage[]): string[] {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return [];
  return messages.slice(latestUserIndex + 1)
    .filter((message) => message.role === 'assistant')
    .map((message) => message.id);
}

/** A short, length-aware pause makes completed replies arrive like chat bubbles. */
export function getLiteReplyDelay(part: LiteReplyPart, reducedMotion = false): number {
  if (reducedMotion) return 0;
  if (part.kind === 'sticker') return 420;
  return Math.min(900, Math.max(300, 260 + part.content.trim().length * 16));
}
