import { TRUNCATE_TO, VALUES_PER_LINE } from '../config';
import { estimateJsonChars } from '../estimate';
import type { ArrayNode, Node } from '../model';
import { textScalar } from '../numfmt';
import type { OutputFormat, RenderContext, RenderOptions } from '../types';

/**
 * Protobuf text format. Messages are `key { ... }`, repeated messages and
 * strings repeat the key (as protoc does), and repeated scalars use the
 * `key: [a, b, c]` list syntax so big tensors stay compact. Truncation markers
 * and notes are `#` comments, which the text format allows.
 */

const INDENT = '  ';
const BYTES_PER_SLICE = 16384;

const ESCAPES: Record<number, string> = {
	0x0a: '\\n',
	0x0d: '\\r',
	0x09: '\\t',
	0x22: '\\"',
	0x5c: '\\\\'
};

/** Escape for one byte inside a double-quoted text-format string. */
const BYTE_ESCAPE: string[] = Array.from({ length: 256 }, (_, b) => {
	if (ESCAPES[b]) return ESCAPES[b];
	if (b >= 0x20 && b < 0x7f) return String.fromCharCode(b);
	return '\\' + b.toString(8).padStart(3, '0');
});

/** Text-format escape for a string field (non-ASCII text is kept as-is). */
function quote(s: string): string {
	// eslint-disable-next-line no-control-regex -- matching control characters is the point
	return '"' + s.replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => BYTE_ESCAPE[ch.charCodeAt(0)]) + '"';
}

function* escapedBytes(bytes: Uint8Array): Generator<string> {
	for (let i = 0; i < bytes.length; i += BYTES_PER_SLICE) {
		const end = Math.min(i + BYTES_PER_SLICE, bytes.length);
		let s = '';
		for (let j = i; j < end; j++) s += BYTE_ESCAPE[bytes[j]];
		yield s;
	}
}

function* writeEntries(
	entries: [string, Node][],
	depth: number,
	opts: RenderOptions
): Generator<string> {
	for (const [key, value] of entries) yield* writeField(key, value, depth, opts);
}

function* writeField(
	key: string,
	node: Node,
	depth: number,
	opts: RenderOptions
): Generator<string> {
	const pad = INDENT.repeat(depth);
	switch (node.k) {
		case 'scalar':
			yield `${pad}${key}: ${textScalar(node.dtype, node.v)}\n`;
			return;
		case 'str':
			yield `${pad}${key}: ${quote(node.v)}\n`;
			return;
		case 'enum':
			yield `${pad}${key}: ${node.name}\n`;
			return;
		case 'bytes':
			yield `${pad}${key}: "`;
			yield* escapedBytes(node.v);
			yield '"\n';
			return;
		case 'obj':
			if (node.note) yield `${pad}# ${node.note}\n`;
			if (node.entries.length === 0) {
				yield `${pad}${key} {}\n`;
				return;
			}
			yield `${pad}${key} {\n`;
			yield* writeEntries(node.entries, depth + 1, opts);
			yield `${pad}}\n`;
			return;
		case 'list':
			for (const item of node.items) yield* writeField(key, item, depth, opts);
			return;
		case 'array':
			yield* writeArray(key, node, depth, opts);
			return;
	}
}

function* writeArray(
	key: string,
	node: ArrayNode,
	depth: number,
	opts: RenderOptions
): Generator<string> {
	const { length, dtype, get } = node;
	const pad = INDENT.repeat(depth);
	const kept = opts.truncateTo == null ? length : Math.min(length, Math.max(0, opts.truncateTo));
	const omitted = length - kept;

	if (omitted === 0 && length <= VALUES_PER_LINE) {
		const vals: string[] = [];
		for (let i = 0; i < length; i++) vals.push(textScalar(dtype, get(i)));
		yield `${pad}${key}: [${vals.join(', ')}]\n`;
		return;
	}

	const inner = INDENT.repeat(depth + 1);
	yield `${pad}${key}: [\n`;
	for (let start = 0; start < kept; start += VALUES_PER_LINE) {
		const end = Math.min(start + VALUES_PER_LINE, kept);
		const vals: string[] = [];
		for (let i = start; i < end; i++) vals.push(textScalar(dtype, get(i)));
		// Commas separate values only; a trailing comma would be invalid before `]`.
		yield inner + vals.join(', ') + (end < kept ? ',\n' : '\n');
	}
	if (omitted > 0) yield `${inner}# ... ${omitted} more values\n`;
	yield `${pad}]\n`;
}

export const prototextFormat: OutputFormat = {
	id: 'prototext',
	label: 'Prototext',
	language: 'prototext',
	truncate: { label: 'values of each tensor', defaultValue: TRUNCATE_TO },
	// Same shape as the JSON, but bytes are escaped (up to 4 chars per byte).
	estimate: (ctx: RenderContext, opts: RenderOptions) =>
		estimateJsonChars(ctx.root, opts.truncateTo, 0, (n) => n * 4 + 2),
	*serialize(ctx: RenderContext, opts: RenderOptions) {
		const root = ctx.root;
		if (root.k === 'obj') yield* writeEntries(root.entries, 0, opts);
		else yield* writeField('value', root, 0, opts);
	}
};
