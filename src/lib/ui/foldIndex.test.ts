import { describe, expect, it } from 'vitest';
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
