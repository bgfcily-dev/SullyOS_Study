import { describe, expect, it } from 'vitest';
import { liteModelsUrl } from './modelApi';

describe('Sully Lite model API', () => {
  it('builds a models endpoint from a normal OpenAI-compatible base URL', () => {
    expect(liteModelsUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/models');
  });

  it('replaces a full chat completions endpoint', () => {
    expect(liteModelsUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/models');
  });

  it('does not duplicate an existing models suffix', () => {
    expect(liteModelsUrl('https://api.example.com/v1/models')).toBe('https://api.example.com/v1/models');
  });
});
