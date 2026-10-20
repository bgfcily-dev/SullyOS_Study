import { describe, expect, it } from 'vitest';
import { buildNewMemoryMetadata, readMemoryMetadata } from './metadata';

describe('new memory metadata', () => {
    it('resolves a first reflection to real IDs without trusting model-written current pointers', () => {
        expect(buildNewMemoryMetadata([
            { metadata: { kind: 'event', current_reflection_id: 'old-memory' } },
            { metadata: { kind: 'reflection', event_id: 'N0', previous_id: 'old-reflection', confidence: 0.45 } },
            { metadata: { kind: 'identity' } },
        ], ['event-1', 'reflection-1', 'identity-1'])).toEqual([
            { kind: 'event', status: 'active', current_reflection_id: 'reflection-1' },
            { kind: 'reflection', status: 'active', event_id: 'event-1', confidence: 0.45 },
            { kind: 'identity', status: 'active' },
        ]);
    });
    it('rejects orphan reflections, old-event references and duplicate first reflections', () => {
        for (const event_id of ['old-id', 'N1', 'N99', undefined]) {
            expect(() => buildNewMemoryMetadata([{ metadata: { kind: 'event' } }, { metadata: { kind: 'reflection', event_id } }], ['e', 'r'])).toThrow('感想必须关联');
        }
        expect(() => buildNewMemoryMetadata([
            { metadata: { kind: 'event' } },
            { metadata: { kind: 'reflection', event_id: 'N0' } },
            { metadata: { kind: 'reflection', event_id: 'N0' } },
        ], ['e', 'r1', 'r2'])).toThrow('一条首次感想');
    });
    it('does not invent confidence or classify legacy records on read', () => {
        expect(buildNewMemoryMetadata([{}, { metadata: { kind: 'event', confidence: 7 } }], ['a', 'b'])).toEqual([
            { kind: 'event', status: 'active' }, { kind: 'event', status: 'active' },
        ]);
        expect(readMemoryMetadata(undefined)).toBeUndefined();
        expect(readMemoryMetadata({ future: { key: true } })).toEqual({ future: { key: true } });
    });
});
