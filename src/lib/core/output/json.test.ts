import { describe, expect, it } from 'vitest';
import { chunked } from '../chunker';
import { estimateJsonChars } from '../estimate';
import type { ArrayNode, Node } from '../model';
import { jsonFormat } from './json';

function render(root: Node, truncateTo: number | null = null): string {
	return [...jsonFormat.serialize({ root, bytes: new Uint8Array() }, { truncateTo })].join('');
}

function floats(n: number): ArrayNode {
	return { k: 'array', dtype: 'float32', length: n, get: (i) => i / 2 };
}

describe('json output', () => {
	it('produces valid JSON for a mixed tree', () => {
		const root: Node = {
			k: 'obj',
			entries: [
				['name', { k: 'str', v: 'a "quoted" \n name' }],
				['ids', { k: 'array', dtype: 'int64', length: 2, get: (i) => (i ? 9007199254740993n : 1) }],
				['flag', { k: 'scalar', dtype: 'bool', v: true }],
				['kind', { k: 'enum', name: 'FLOAT', num: 1 }],
				['blob', { k: 'bytes', v: new Uint8Array([104, 105, 33]) }],
				['empty', { k: 'obj', entries: [] }],
				[
					'list',
					{
						k: 'list',
						items: [
							{ k: 'str', v: 'x' },
							{ k: 'str', v: 'y' }
						]
					}
				],
				['nested', { k: 'list', items: [{ k: 'obj', entries: [['v', floats(40)]] }] }]
			]
		};
		const parsed = JSON.parse(render(root));
		expect(parsed.name).toBe('a "quoted" \n name');
		expect(parsed.ids).toEqual(['1', '9007199254740993']);
		expect(parsed.blob).toBe('aGkh');
		expect(parsed.list).toEqual(['x', 'y']);
		expect(parsed.nested[0].v).toHaveLength(40);
		expect(parsed.nested[0].v[3]).toBe(1.5);
	});

	it('keeps short arrays inline and wraps long ones', () => {
		expect(render(floats(3))).toBe('[0, 0.5, 1]\n');
		const lines = render(floats(40)).split('\n');
		expect(lines[0]).toBe('[');
		expect(lines[1].split(', ')).toHaveLength(16);
	});

	it('truncates with a marker and stays valid JSON', () => {
		const out = render({ k: 'obj', entries: [['v', floats(5000)]] }, 100);
		const parsed = JSON.parse(out);
		expect(parsed.v).toHaveLength(101);
		expect(parsed.v[100]).toBe('... 4900 more values');
		expect(out).not.toContain('2499.5');
	});

	it('truncating to zero leaves only the marker', () => {
		expect(JSON.parse(render(floats(20), 0))).toEqual(['... 20 more values']);
	});

	it('does not truncate arrays already short enough', () => {
		expect(JSON.parse(render(floats(50), 100))).toHaveLength(50);
	});
});

describe('estimateJsonChars', () => {
	it('is within a reasonable factor of the real size', () => {
		const root: Node = { k: 'obj', entries: [['v', floats(100_000)]] };
		const real = render(root).length;
		const est = estimateJsonChars(root, null);
		expect(est / real).toBeGreaterThan(0.5);
		expect(est / real).toBeLessThan(2);
	});

	it('shrinks with truncation', () => {
		const root: Node = { k: 'obj', entries: [['v', floats(1_000_000)]] };
		expect(estimateJsonChars(root, 1000)).toBeLessThan(estimateJsonChars(root, null) / 100);
	});
});

describe('chunked', () => {
	it('rebatches strings without losing data', () => {
		const parts = Array.from({ length: 1000 }, (_, i) => `p${i},`);
		const out = [...chunked(parts, 500)];
		expect(out.join('')).toBe(parts.join(''));
		expect(out.length).toBeGreaterThan(1);
		for (const c of out.slice(0, -1)) expect(c.length).toBeGreaterThanOrEqual(500);
	});
});
