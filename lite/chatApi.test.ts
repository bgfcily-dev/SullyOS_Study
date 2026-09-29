import { describe, expect, it } from 'vitest';
import { extractLiteTokenUsage } from './chatApi';

describe('Sully Lite token usage', () => {
  it('reads OpenAI-compatible prompt and completion usage', () => {
    expect(extractLiteTokenUsage({ prompt_tokens: 1200, completion_tokens: 86, total_tokens: 1286 })).toEqual({
      promptTokens: 1200,
      completionTokens: 86,
      totalTokens: 1286,
    });
  });

  it('supports input/output aliases and derives the total', () => {
    expect(extractLiteTokenUsage({ input_tokens: 900, output_tokens: 100 })).toEqual({
      promptTokens: 900,
      completionTokens: 100,
      totalTokens: 1000,
    });
  });

  it('returns null when the provider omits usage', () => {
    expect(extractLiteTokenUsage(undefined)).toBeNull();
    expect(extractLiteTokenUsage({ total_tokens: 0 })).toBeNull();
  });
});
