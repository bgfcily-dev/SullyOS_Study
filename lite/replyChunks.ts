const CLOSING_MARKS = new Set(['”', '’', '」', '』', '】', '）', ')', ']', '》']);
const HARD_END_MARKS = new Set(['。', '！', '？', '!', '?']);

/** Split a model reply into chat bubbles without relying on model formatting. */
export function splitLiteReply(text: string, maxBubbles = 8): string[] {
  const source = text.trim();
  if (!source) return [];
  const chunks: string[] = [];
  let buffer = '';

  const flush = () => {
    const value = buffer.trim();
    if (value) chunks.push(value);
    buffer = '';
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    buffer += char;
    const next = source[index + 1] || '';

    if (char === '\n' || char === '\r') {
      while (source[index + 1] === '\n' || source[index + 1] === '\r') index += 1;
      flush();
      continue;
    }

    const englishPeriodEnd = char === '.' && (!next || /\s/.test(next));
    const ellipsisEnd = char === '…' && next !== '…';
    if (!HARD_END_MARKS.has(char) && !englishPeriodEnd && !ellipsisEnd) continue;

    while (CLOSING_MARKS.has(source[index + 1])) {
      index += 1;
      buffer += source[index];
    }
    flush();
  }
  flush();

  if (chunks.length <= maxBubbles) return chunks;
  return [...chunks.slice(0, maxBubbles - 1), chunks.slice(maxBubbles - 1).join('')];
}

export type LiteReplyPart =
  | { kind: 'text'; content: string }
  | { kind: 'sticker'; name: string };

/** Split original-style SEND_EMOJI commands into ordered image/text bubbles. */
export function splitLiteReplyParts(text: string, knownStickerNames: string[]): LiteReplyPart[] {
  const known = new Set(knownStickerNames.map((name) => name.trim()).filter(Boolean));
  const parts: LiteReplyPart[] = [];
  const command = /\[\[SEND_EMOJI[:：]\s*(.*?)\]\]/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushText = (value: string) => {
    splitLiteReply(value).forEach((content) => parts.push({ kind: 'text', content }));
  };

  while ((match = command.exec(text)) !== null) {
    if (match.index > lastIndex) pushText(text.slice(lastIndex, match.index));
    const name = match[1].trim();
    if (known.has(name)) {
      parts.push({ kind: 'sticker', name });
    } else if (name) {
      // Keep an unknown model command readable instead of losing the reply.
      parts.push({ kind: 'text', content: `[表情包：${name}]` });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) pushText(text.slice(lastIndex));
  if (parts.length === 0) pushText(text);
  return parts;
}
