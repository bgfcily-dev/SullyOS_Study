import { describe, expect, it } from 'vitest';
import worker, { parseVectorInput, type Env } from './index';

const unusedEnv = (token?: string): Env => ({
  SYNC_TOKEN: token,
  DB: {} as Env['DB'],
  VECTORS: {} as Env['VECTORS'],
});

describe('memory-sync vector wire format', () => {
  it('accepts the pgvector string used by the existing client', () => {
    expect(parseVectorInput('[0.25,-1,2]')).toEqual([0.25, -1, 2]);
  });

  it('accepts JSON arrays and rejects malformed values', () => {
    expect(parseVectorInput([1, '2', 3])).toEqual([1, 2, 3]);
    expect(parseVectorInput('[1,nope]')).toBeNull();
    expect(parseVectorInput([])).toBeNull();
  });
});

describe('memory-sync access control', () => {
  it('answers CORS preflight without touching storage', async () => {
    const response = await worker.fetch(new Request('https://sync.example/rest/v1/memory_vectors', { method: 'OPTIONS' }), unusedEnv());
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('apikey');
  });

  it('refuses requests when the secret is absent or wrong', async () => {
    const request = new Request('https://sync.example/health', { headers: { Authorization: 'Bearer wrong' } });
    expect((await worker.fetch(request, unusedEnv())).status).toBe(503);
    expect((await worker.fetch(request, unusedEnv('right'))).status).toBe(401);
  });
});
