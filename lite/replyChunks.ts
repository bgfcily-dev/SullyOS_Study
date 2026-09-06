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
