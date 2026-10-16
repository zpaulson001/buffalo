import { describe, expect, it } from 'vitest';
import type { Node } from './model';
import { answerQuery, complete, formatPath, go, locationAt, parsePath, sibling } from './navigate';
import { Outline } from './outline';
import { fbtFormat } from './output/fbt';
import { jsonFormat } from './output/json';
import { prototextFormat } from './output/prototext';
import type { OutputFormat } from './types';

const sc = (v: number): Node => ({ k: 'scalar', dtype: 'int32', v });
const st = (v: string): Node => ({ k: 'str', v });
const ob = (...e: [string, Node][]): Node => ({ k: 'obj', entries: e });
const li = (...i: Node[]): Node => ({ k: 'list', items: i });
const ar = (n: number): Node => ({ k: 'array', dtype: 'int32', length: n, get: (i) => i * 10 });

const NAMES = ['conv_a', 'conv_b', 'relu_c', 'pool_d', 'fc_e'];

const tree = ob(
	['version', sc(3)],
	['name', st('model')],
	[
		'graph',
		ob(
			['name', st('g')],
			[
				'node',
				li(
					...NAMES.map((name, i) =>
						ob(
							['name', st(name)],
							['op_type', st(i < 2 ? 'Conv' : 'Relu')],
							['input', li(st('x'), st('w'))],
							...(i < 2
								? [['attribute', li(ob(['k', sc(1)]), ob(['k', sc(2)]))] as [string, Node]]
								: []),
							['dims', ar(3)]
						)
					)
				)
			],
			[
				'initializer',
				li(ob(['name', st('w0')], ['data', ob(['dtype', st('INT32')], ['values', ar(50)])]))
			],
			['blob', { k: 'bytes', v: new Uint8Array([10, 20, 30, 40]) }]
		)
	]
);

function render(format: OutputFormat, truncateTo: number | null = null) {
	const outline = new Outline();
	let text = '';
	for (const s of format.serialize(
		{ root: tree, bytes: new Uint8Array() },
		{ truncateTo },
		outline
	)) {
		outline.advance(s);
		text += s;
	}
	outline.finish();
	return { outline, lines: text.split('\n') };
}

function target(outline: Outline, text: string, line = 1) {
	const r = go(tree, outline, text, line);
	if (r.kind !== 'target')
		throw new Error(`expected a target for "${text}", got ${JSON.stringify(r)}`);
	return r.target;
}

describe.each([
	['json', jsonFormat],
	['prototext', prototextFormat],
	['fbt', fbtFormat]
] as [string, OutputFormat][])('navigation in %s', (_name, format) => {
	const { outline, lines } = render(format);
	const slice = (t: { line: number; endLine: number }) =>
		lines.slice(t.line - 1, t.endLine).join('\n');

	it('maps a path to exactly the lines of that element', () => {
		const t = target(outline, 'graph.node[3]');
		expect(t.path).toBe('graph.node[3]');
		expect(slice(t)).toContain('pool_d');
		expect(slice(t)).not.toContain('relu_c');
		expect(slice(t)).not.toContain('fc_e');
	});

	it('every recorded element round-trips path -> line', () => {
		for (let r = 1; r < outline.size; r++) {
			const path = formatPath(outline.segments(r));
			expect(target(outline, path).line, path).toBe(outline.startOf(r));
		}
	});

	it('closes every record on a real line', () => {
		for (let r = 0; r < outline.size; r++) {
			expect(outline.isClosed(r)).toBe(true);
			expect(outline.endOf(r)).toBeGreaterThanOrEqual(outline.startOf(r));
			expect(outline.endOf(r)).toBeLessThanOrEqual(lines.length);
		}
	});

	it('finds a tensor value by index and says which token to select', () => {
		const t = target(outline, 'graph.initializer[0].data.values[20]');
		expect(lines[t.line - 1]).toContain('200');
		const row = lines[t.line - 1]
			.replace(/^\s+/, '')
			.replace(/[[\],]*$/, '')
			.split(', ');
		expect(row[t.refine!.value!.offset]).toBe('200');
	});

	it('finds the first and last value, and short inline arrays', () => {
		expect(lines[target(outline, 'graph.initializer[0].data.values[0]').line - 1]).toContain(
			'0, 10'
		);
		expect(lines[target(outline, 'graph.initializer[0].data.values[49]').line - 1]).toContain(
			'490'
		);
		const dims = target(outline, 'graph.node[0].dims[2]');
		expect(lines[dims.line - 1]).toContain('20');
		expect(dims.refine?.value?.header).toBe(true);
	});

	it('reports out-of-range and unknown fields helpfully', () => {
		const range = go(tree, outline, 'graph.node[9]', 1);
		expect(range).toMatchObject({
			kind: 'error',
			message: expect.stringContaining('5 items (0–4)')
		});
		const unknown = go(tree, outline, 'graph.nodes[0]', 1);
		expect(unknown).toMatchObject({
			kind: 'error',
			message: expect.stringContaining('Did you mean: node')
		});
		const scalar = go(tree, outline, 'version[0]', 1);
		expect(scalar.kind).toBe('error');
	});

	it('targets a scalar field by pointing at its parent and the key', () => {
		const t = target(outline, 'graph.node[1].op_type');
		expect(t.refine?.key).toBe('op_type');
		expect(slice(t)).toContain('conv_b');
	});

	it('resolves bare names, asking when ambiguous', () => {
		expect(target(outline, 'node[2]').path).toBe('graph.node[2]');
		const ambiguous = go(tree, outline, 'attribute[1]', 1);
		expect(ambiguous.kind).toBe('choices');
		if (ambiguous.kind === 'choices') {
			expect(ambiguous.choices.map((c) => c.path)).toEqual([
				'graph.node[0].attribute[1]',
				'graph.node[1].attribute[1]'
			]);
		}
	});

	it('supports #N inside the current list', () => {
		const here = target(outline, 'graph.node[0]').line + 1;
		expect(target(outline, '#3', here).path).toBe('graph.node[3]');
		expect(go(tree, outline, '#1', 1)).toMatchObject({ kind: 'error' });
	});

	it('searches names, exactly and loosely', () => {
		expect(target(outline, 'name=="conv_b"').path).toBe('graph.node[1]');
		const loose = go(tree, outline, 'conv', 1);
		expect(loose.kind).toBe('choices');
		if (loose.kind === 'choices') {
			expect(loose.choices.map((c) => c.label)).toEqual(['conv_a', 'conv_b']);
		}
		expect(target(outline, 'relu_c').path).toBe('graph.node[2]');
		expect(go(tree, outline, 'nothing_like_this', 1)).toMatchObject({ kind: 'error' });
		// A choice's path jumps to the same place.
		if (loose.kind === 'choices')
			expect(target(outline, loose.choices[1].path).path).toBe('graph.node[1]');
	});

	it('describes where a line is', () => {
		const start = target(outline, 'graph.node[3]').line;
		expect(locationAt(outline, start)?.path).toBe('graph.node[3]');
		expect(locationAt(outline, start)?.crumbs.map((c) => c.label)).toEqual(['graph', 'node[3]']);
		const row = target(outline, 'graph.initializer[0].data.values[20]').line;
		const there = locationAt(outline, row)!;
		expect(there.crumbs.at(-1)?.label).toBe('[16–31]');
		expect(there.path).toBe('graph.initializer[0].data.values[16]');
	});

	it('moves between siblings and up', () => {
		const at = target(outline, 'graph.node[2]').line;
		const next = sibling(outline, at, 'next');
		expect(next).toMatchObject({ kind: 'target', target: { path: 'graph.node[3]' } });
		expect(sibling(outline, at, 'prev')).toMatchObject({ target: { path: 'graph.node[1]' } });
		expect(sibling(outline, at, 'parent')).toMatchObject({ target: { path: 'graph.node' } });
		const last = target(outline, 'graph.node[4]').line;
		expect(sibling(outline, last, 'next')).toMatchObject({ kind: 'error' });
	});

	it('labels list elements and tensor rows', () => {
		const labels = new Map(outline.labels(1, lines.length));
		const n2 = target(outline, 'graph.node[2]').line;
		expect(labels.get(n2)).toBe('[2]');
		const row = target(outline, 'graph.initializer[0].data.values[32]').line;
		expect(labels.get(row)).toBe('[32]');
		expect(labels.get(row - 1)).toBe('[16]');
	});

	it('does not label items of a list written on one line', () => {
		const labels = new Map(outline.labels(1, lines.length));
		const input = target(outline, 'graph.node[1].input').line;
		// Prototext writes each item on its own `input:` line, so there each one is labelled.
		if (_name === 'prototext') expect(labels.get(input)).toBe('[0]');
		else expect(labels.has(input)).toBe(false);
	});

	it('completes fields and explains indices', () => {
		expect(complete(tree, outline, 'graph.no').completions).toEqual(['graph.node']);
		expect(complete(tree, outline, 'graph.node[').text).toContain('5 items');
		expect(complete(tree, outline, 'graph.initializer[0].data.values[').text).toContain(
			'50 values'
		);
		expect(complete(tree, outline, '').completions).toContain('graph');
		// A field that isn't at the top level still gets a useful hint.
		expect(complete(tree, outline, 'node[').text).toContain('graph.node: 5 items');
		expect(complete(tree, outline, 'attribute[').text).toContain('several places');
	});

	it('answers protocol queries', () => {
		expect(answerQuery(tree, outline, { op: 'go', text: 'graph.node[1]', line: 1 }).kind).toBe(
			'target'
		);
		expect(answerQuery(tree, outline, { op: 'pathAt', line: 1 })).toMatchObject({
			kind: 'location'
		});
		expect(answerQuery(tree, outline, { op: 'labels', from: 1, to: 5 }).kind).toBe('labels');
	});
});

describe('truncated output', () => {
	it.each([
		['json', jsonFormat],
		['prototext', prototextFormat]
	] as [string, OutputFormat][])('%s points past-the-end indices at the marker', (_n, format) => {
		const { outline, lines } = render(format, 10);
		const t = target(outline, 'graph.initializer[0].data.values[30]');
		expect(t.note).toContain('first 10');
		expect(lines[t.line - 1]).toContain('more values');
		expect(lines[target(outline, 'graph.initializer[0].data.values[9]').line - 1]).toContain('90');
	});
});

describe('bytes', () => {
	it('can be indexed in FBT (written as numbers) but not in JSON (base64)', () => {
		const fbt = render(fbtFormat);
		const t = target(fbt.outline, 'graph.blob[2]');
		expect(fbt.lines[t.line - 1]).toContain('30');
		const json = render(jsonFormat);
		expect(go(tree, json.outline, 'graph.blob[2]', 1)).toMatchObject({ kind: 'error' });
	});
});

describe('parsePath / formatPath', () => {
	it('round-trips every step kind', () => {
		expect(parsePath('a.b[3]["odd key"][name=="x y"]')).toEqual([
			{ t: 'key', key: 'a' },
			{ t: 'key', key: 'b' },
			{ t: 'index', index: 3 },
			{ t: 'key', key: 'odd key' },
			{ t: 'pred', key: 'name', value: 'x y' }
		]);
		expect(formatPath(['a', 'b', 3, 'odd key'])).toBe('a.b[3]["odd key"]');
	});

	it('explains syntax errors', () => {
		expect(parsePath('a[3')).toMatchObject({ error: expect.stringContaining('closing ]') });
		expect(parsePath('a[x]')).toMatchObject({ error: expect.stringContaining('Use [3]') });
		expect(parsePath('/model/x')).toMatchObject({
			error: expect.stringContaining('Unexpected "/"')
		});
	});
});

describe('outline limits', () => {
	it('stays consistent while still streaming', () => {
		const outline = new Outline();
		const gen = jsonFormat.serialize(
			{ root: tree, bytes: new Uint8Array() },
			{ truncateTo: null },
			outline
		);
		let n = 0;
		for (const s of gen) {
			outline.advance(s);
			if (++n === 40) break; // stop partway
		}
		const r = go(tree, outline, 'graph.node[4]', 1);
		expect(r.kind).toBe('error');
		if (r.kind === 'error') expect(r.message).toMatch(/hasn.t been rendered yet/);
		expect(outline.complete).toBe(false);
	});
});
