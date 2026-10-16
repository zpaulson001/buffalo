import { describe, expect, it } from 'vitest';
import { tfliteFormat } from '../input/tflite';
import { buildTflite } from '../input/tflite/testing';
import type { ArrayNode, Node } from '../model';
import { fbtFormat } from './fbt';
import { jsonFormat } from './json';

function render(root: Node, truncateTo: number | null = null): string {
	return [...fbtFormat.serialize({ root, bytes: new Uint8Array() }, { truncateTo })].join('');
}

function nums(n: number): ArrayNode {
	return { k: 'array', dtype: 'float32', length: n, get: (i) => i / 2 };
}

describe('fbt (flatc text)', () => {
	const root: Node = {
		k: 'obj',
		entries: [
			['version', { k: 'scalar', dtype: 'uint32', v: 3 }],
			['big', { k: 'scalar', dtype: 'int64', v: 9007199254740993n }],
			['name', { k: 'str', v: 'Orc "ü"\n' }],
			['color', { k: 'enum', name: 'Blue', num: 5 }],
			['odd', { k: 'enum', name: '5', num: 5 }],
			['ok', { k: 'scalar', dtype: 'bool', v: true }],
			['blob', { k: 'bytes', v: new Uint8Array([1, 2, 255]) }],
			['weird key', { k: 'str', v: 'x' }],
			['nested', { k: 'list', items: [{ k: 'obj', entries: [['v', nums(2)]] }] }],
			[
				'bad',
				{ k: 'array', dtype: 'float32', length: 3, get: (i) => [NaN, Infinity, -Infinity][i] }
			]
		]
	};

	it('uses bare keys and enum names, plain 64-bit ints, byte lists', () => {
		const out = render(root);
		expect(out).toContain('  version: 3,\n');
		expect(out).toContain('  big: 9007199254740993,\n');
		expect(out).toContain('  name: "Orc \\"ü\\"\\n",\n');
		expect(out).toContain('  color: Blue,\n');
		expect(out).toContain('  odd: "5",\n');
		expect(out).toContain('  ok: true,\n');
		expect(out).toContain('  blob: [1, 2, 255],\n');
		expect(out).toContain('  "weird key": "x",\n');
		expect(out).toContain('  nested: [\n    {\n      v: [0, 0.5]\n    }\n  ],\n');
		expect(out).toContain('  bad: [nan, inf, -inf]\n');
	});

	it('truncates byte vectors with a marker', () => {
		const big = new Uint8Array(100).map((_, i) => i);
		const out = render({ k: 'obj', entries: [['data', { k: 'bytes', v: big }]] }, 5);
		expect(out).toContain('0, 1, 2, 3, 4,\n    "... 95 more values"\n  ]');
	});

	it('leaves strict JSON output unchanged', () => {
		const out = [
			...jsonFormat.serialize({ root, bytes: new Uint8Array() }, { truncateTo: null })
		].join('');
		expect(() => JSON.parse(out.replace(/Infinity|NaN/g, '0'))).not.toThrow();
		expect(JSON.parse(out).big).toBe('9007199254740993');
		expect(JSON.parse(out).color).toBe('Blue');
	});

	it('renders a decoded .tflite in flatc style', () => {
		const bytes = buildTflite();
		const root = tfliteFormat.decode(bytes);
		const out = [...fbtFormat.serialize({ root, bytes }, { truncateTo: null })].join('');
		expect(out).toContain('version: 3,');
		expect(out).toContain('type: INT64,');
		expect(out).toMatch(/values: \[1, 9007199254740993\]/);
	});

	it('estimates close to the real size', () => {
		const r: Node = { k: 'obj', entries: [['v', nums(100_000)]] };
		const real = render(r).length;
		const est = fbtFormat.estimate({ root: r, bytes: new Uint8Array() }, { truncateTo: null });
		expect(est / real).toBeGreaterThan(0.5);
		expect(est / real).toBeLessThan(2);
	});
});
