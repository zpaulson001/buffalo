import { describe, expect, it } from 'vitest';
import type { Node } from '../core/model';
import { Outline } from '../core/outline';
import { fbtFormat } from '../core/output/fbt';
import { jsonFormat } from '../core/output/json';
import { prototextFormat } from '../core/output/prototext';
import type { OutputFormat } from '../core/types';
import { FoldIndex } from './foldIndex';

const TEXT = [
	'graph {', // 1
	'  node {', // 2
	'    op: "Add"', // 3
	'  }', // 4
	'  dims: [', // 5
	'    1, 2,', // 6
	'  ]', // 7
	'}', // 8
	''
].join('\n');

describe('FoldIndex', () => {
	it('matches blocks and lists by nesting', () => {
		const idx = new FoldIndex();
		idx.push(TEXT);
		expect(idx.closeOf(1)).toBe(8);
		expect(idx.closeOf(2)).toBe(4);
		expect(idx.closeOf(5)).toBe(7);
		expect(idx.closeOf(3)).toBeUndefined();
	});

	it('gives the same result when text arrives in arbitrary pieces', () => {
		const idx = new FoldIndex();
		for (let i = 0; i < TEXT.length; i += 5) idx.push(TEXT.slice(i, i + 5));
		expect(idx.closeOf(1)).toBe(8);
		expect(idx.closeOf(2)).toBe(4);
		expect(idx.closeOf(5)).toBe(7);
	});

	it('does not close a block until its closing line is complete', () => {
		const idx = new FoldIndex();
		idx.push('a {\n}');
		expect(idx.closeOf(1)).toBeUndefined();
		idx.push('\n');
		expect(idx.closeOf(1)).toBe(2);
	});

	it('reset clears state', () => {
		const idx = new FoldIndex();
		idx.push(TEXT);
		idx.reset();
		expect(idx.closeOf(1)).toBeUndefined();
		idx.push('x {\n}\n');
		expect(idx.closeOf(1)).toBe(2);
	});
});

describe('FoldIndex agrees with the navigation outline', () => {
	const item = (i: number): Node => ({
		k: 'obj',
		entries: [
			['name', { k: 'str', v: `n${i}` }],
			[
				'input',
				{
					k: 'list',
					items: [
						{ k: 'str', v: 'a' },
						{ k: 'str', v: 'b' }
					]
				}
			],
			['attribute', { k: 'list', items: [{ k: 'obj', entries: [['k', { k: 'str', v: 'v' }]] }] }]
		]
	});
	const tree: Node = {
		k: 'obj',
		entries: [
			['version', { k: 'scalar', dtype: 'int32', v: 1 }],
			[
				'graph',
				{
					k: 'obj',
					entries: [
						['node', { k: 'list', items: Array.from({ length: 30 }, (_, i) => item(i)) }],
						['data', { k: 'array', dtype: 'int32', length: 100, get: (i: number) => i } as Node]
					]
				}
			]
		]
	};

	it.each([
		['json', jsonFormat],
		['prototext', prototextFormat],
		['fbt', fbtFormat]
	] as [string, OutputFormat][])(
		'every block that spans lines can be folded (%s)',
		(_name, format) => {
			const outline = new Outline();
			const index = new FoldIndex();
			for (const text of format.serialize(
				{ root: tree, bytes: new Uint8Array() },
				{ truncateTo: null },
				outline
			)) {
				outline.advance(text);
				index.push(text);
			}
			outline.finish();
			let blocks = 0;
			for (let r = 0; r < outline.size; r++) {
				if (outline.kindOf(r) === 'leaf' || outline.endOf(r) === outline.startOf(r)) continue;
				// Prototext has no braces for the root and repeats `node {` instead of wrapping a list,
				// so neither of those is a foldable block there.
				if (_name === 'prototext' && (r === 0 || outline.kindOf(r) === 'list')) continue;
				blocks++;
				expect(index.closeOf(outline.startOf(r)), `record ${r} at line ${outline.startOf(r)}`).toBe(
					outline.endOf(r)
				);
			}
			expect(blocks).toBeGreaterThan(30);
		}
	);
});
