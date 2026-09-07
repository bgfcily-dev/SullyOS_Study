import { describe, expect, it } from 'vitest';
import { parseRemoteVector } from './supabaseVector';

describe('remote vector decoding', () => {
    it('decodes pgvector text returned by PostgREST', () => {
        expect(Array.from(parseRemoteVector('[0.25,-1,2]') || [])).toEqual([0.25, -1, 2]);
    });

    it('rejects malformed vectors', () => {
        expect(parseRemoteVector('[1,nope,3]')).toBeNull();
        expect(parseRemoteVector('')).toBeNull();
    });
});
