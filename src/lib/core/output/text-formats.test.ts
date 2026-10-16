import { describe, expect, it } from 'vitest';
import type { ArrayNode, Node } from '../model';
import type { OutputFormat } from '../types';
import { hexFormat } from './hex';
import { prototextFormat } from './prototext';

function render(
	format: OutputFormat,
	root: Node,
	truncateTo: number | null = null,
	bytes = new Uint8Array()
): string {
	return [...format.serialize({ root, bytes }, { truncateTo })].join('');
}

function nums(n: number, dtype: ArrayNode['dtype'] = 'float32'): ArrayNode {
	return { k: 'array', dtype, length: n, get: (i) => i / 2 };
}

describe('prototext', () => {
	const root: Node = {
		k: 'obj',
		entries: [
			['ir_version', { k: 'scalar', dtype: 'int64', v: 9007199254740993n }],
			['name', { k: 'str', v: 'a "q"\n\\ é' }],
			['kind', { k: 'enum', name: 'FLOAT', num: 1 }],
			['ok', { k: 'scalar', dtype: 'bool', v: true }],
			['blob', { k: 'bytes', v: new Uint8Array([0, 65, 10, 34, 255]) }],
			['dims', nums(3, 'int64')],
			[
				'node',
				{
					k: 'list',
					items: [
						{ k: 'obj', entries: [['op', { k: 'str', v: 'Add' }]] },
						{ k: 'obj', entries: [['op', { k: 'str', v: 'Mul' }]] }
					]
				}
			],
			[
				'tags',
				{
					k: 'list',
					items: [
						{ k: 'str', v: 'x' },
						{ k: 'str', v: 'y' }
					]
				}
			],
			['empty', { k: 'obj', entries: [] }],
			['data', { k: 'obj', note: 'decoded', entries: [['values', nums(40)]] }]
		]
	};

	it('writes fields in text format', () => {
		const out = render(prototextFormat, root);
		expect(out).toContain('ir_version: 9007199254740993\n');
		expect(out).toContain('name: "a \\"q\\"\\n\\\\ é"\n');
		expect(out).toContain('kind: FLOAT\n');
		expect(out).toContain('ok: true\n');
		expect(out).toContain('blob: "\\000A\\n\\"\\377"\n');
		expect(out).toContain('dims: [0, 0.5, 1]\n');
		expect(out).toContain('node {\n  op: "Add"\n}\nnode {\n  op: "Mul"\n}\n');
		expect(out).toContain('tags: "x"\ntags: "y"\n');
		expect(out).toContain('empty {}\n');
		expect(out).toContain('# decoded\ndata {\n  values: [\n');
	});

	it('wraps long arrays without a trailing comma', () => {
		const lines = render(prototextFormat, root).split('\n');
		const start = lines.indexOf('  values: [');
		expect(lines[start + 1].split(', ')).toHaveLength(16);
		expect(lines[start + 1].endsWith(',')).toBe(true);
		expect(lines[start + 3].endsWith(',')).toBe(false); // last value line
		expect(lines[start + 4]).toBe('  ]');
	});

	it('truncates with a comment marker', () => {
		const out = render(prototextFormat, { k: 'obj', entries: [['v', nums(5000)]] }, 20);
		expect(out).toContain('9.5\n  # ... 4980 more values\n]\n');
		expect(out).not.toContain('2499.5');
		const values = out.split('\n').slice(1, 3).join(' ');
		expect(values.split(',')).toHaveLength(20);
	});

	it('prints non-finite floats the text-format way', () => {
		const a: ArrayNode = {
			k: 'array',
			dtype: 'float32',
			length: 3,
			get: (i) => [NaN, Infinity, -Infinity][i]
		};
		expect(render(prototextFormat, { k: 'obj', entries: [['v', a]] })).toBe(
			'v: [nan, inf, -inf]\n'
		);
	});
});

describe('hex', () => {
	it('formats like hexdump -C', () => {
		const bytes = new TextEncoder().encode('Hello, protobuf world!\n');
		const lines = render(hexFormat, { k: 'obj', entries: [] }, null, bytes).split('\n');
		expect(lines[0]).toBe(
			'00000000  48 65 6c 6c 6f 2c 20 70  72 6f 74 6f 62 75 66 20  |Hello, protobuf |'
		);
		// Partial last line is padded so the ASCII column lines up.
		expect(lines[1]).toBe('00000010  77 6f 72 6c 64 21 0a                              |world!.|');
	});

	it('truncates to N bytes with a marker', () => {
		const bytes = new Uint8Array(100).map((_, i) => i);
		const out = render(hexFormat, { k: 'obj', entries: [] }, 20, bytes);
		const lines = out.trimEnd().split('\n');
		expect(lines).toHaveLength(3);
		expect(lines[1].startsWith('00000010  10 11 12 13')).toBe(true);
		expect(lines[2]).toBe('... 80 more bytes');
	});

	it('estimates close to the real size', () => {
		const bytes = new Uint8Array(10_000);
		const real = render(hexFormat, { k: 'obj', entries: [] }, null, bytes).length;
		const est = hexFormat.estimate(
			{ root: { k: 'obj', entries: [] }, bytes },
			{ truncateTo: null }
		);
		expect(Math.abs(est - real) / real).toBeLessThan(0.05);
	});
});
