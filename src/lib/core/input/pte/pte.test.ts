import { describe, expect, it } from 'vitest';
import { detectInputFormat } from '../../formats';
import { jsonFormat } from '../../output/json';
import { pteFormat } from './index';
import { readExtendedHeader } from './tensors';
import { buildPte } from './testing';

function toJson(bytes: Uint8Array, truncateTo: number | null = null) {
	const root = pteFormat.decode(bytes);
	return JSON.parse([...jsonFormat.serialize({ root, bytes }, { truncateTo })].join(''));
}

/** A decoded tensor, loosely typed for assertions. */
interface Tensor {
	sizes?: number[];
	scalar_type?: string;
	data?: { dtype: string; values: unknown[] };
}

function tensorsOf(out: { execution_plan: { values: { val: Tensor }[] }[] }): Tensor[] {
	return out.execution_plan[0].values.map((v) => v.val);
}

describe('pte', () => {
	it('is picked by file extension', () => {
		expect(detectInputFormat('model.pte')).toBe(pteFormat);
	});

	describe.each(['inline', 'segment'] as const)('%s constants', (layout) => {
		const out = toJson(buildPte({ layout }));
		const [activation, weights, ids] = tensorsOf(out);

		it('reads the program structure with the bundled schemas', () => {
			expect(out.execution_plan[0].name).toBe('forward');
			expect(out.execution_plan[0].values.map((v: { val_type: string }) => v.val_type)).toEqual([
				'Tensor',
				'Tensor',
				'Tensor'
			]);
			expect(activation.sizes).toEqual([2, 3]);
			expect(ids.scalar_type).toBe('LONG');
		});

		it('leaves non-constant tensors alone', () => {
			expect(activation.data).toBeUndefined();
		});

		it('decodes constant tensors next to their sizes and type', () => {
			expect(weights.data!.dtype).toBe('FLOAT');
			expect(weights.data!.values).toHaveLength(6);
			expect(weights.data!.values[1]).toBeCloseTo(Math.sin(1) * 0.37, 6);
			expect(ids.data).toEqual({ dtype: 'LONG', values: ['1', '9007199254740993'] });
		});
	});

	it('exposes the extended header only when present', () => {
		const withHeader = toJson(buildPte({ layout: 'segment' }));
		expect(withHeader.extended_header.program_size).toBeTypeOf('string');
		expect(Number(withHeader.extended_header.segment_base_offset) % 128).toBe(0);
		expect(toJson(buildPte({ layout: 'inline' })).extended_header).toBeUndefined();
		expect(readExtendedHeader(buildPte({ layout: 'inline' }))).toBeUndefined();
	});

	it('reports segment metadata from the schema', () => {
		const out = toJson(buildPte({ layout: 'segment' }));
		expect(out.segments).toHaveLength(1);
		expect(out.constant_segment.offsets).toHaveLength(3);
	});

	it('truncates decoded constants', () => {
		const big = toJson(buildPte({ layout: 'segment', floatCount: 500 }), 5);
		const w = tensorsOf(big)[1].data!;
		expect(w.values).toHaveLength(6);
		expect(w.values[5]).toBe('... 495 more values');
	});

	it('skips decoding when the segment is out of range, instead of failing', () => {
		const bytes = buildPte({ layout: 'segment' });
		const cut = toJson(bytes.subarray(0, bytes.length - 40));
		const [, weights] = tensorsOf(cut);
		expect(weights.data).toBeUndefined();
	});

	it('rejects a file with another identifier', () => {
		const bytes = buildPte({ layout: 'inline' });
		bytes.set(new TextEncoder().encode('TFL3'), 4);
		expect(() => pteFormat.decode(bytes)).toThrow(/identifier "TFL3".*"ET12"/);
	});
});
