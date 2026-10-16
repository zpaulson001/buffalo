import { base64Chunks } from '../base64';
import { INLINE_LIST_MAX, TRUNCATE_TO, VALUES_PER_LINE } from '../config';
import { estimateJsonChars } from '../estimate';
import type { ArrayNode, DType, Node, ScalarValue } from '../model';
import type { Marks, Seg } from '../outline';
import { jsonScalar } from '../numfmt';
import type { OutputFormat, RenderContext, RenderOptions } from '../types';

const INDENT = '  ';

/**
 * How a JSON-shaped output spells things. JSON is strict; FlatBuffers' own text
 * format (see fbt.ts) shares the layout but not the tokens.
 */
export interface JsonStyle {
	key(name: string): string;
	scalar(dtype: DType, v: ScalarValue): string;
	enumToken(name: string): string;
	/** Print `bytes` as a list of numbers (flatc does) instead of a base64 string. */
	bytesAsNumbers: boolean;
}

export const JSON_STYLE: JsonStyle = {
	key: (name) => JSON.stringify(name),
	scalar: jsonScalar,
	enumToken: (name) => JSON.stringify(name),
	bytesAsNumbers: false
};

function isPrimitive(n: Node): boolean {
	return n.k === 'scalar' || n.k === 'str' || n.k === 'enum';
}

/**
 * `seg` is how this node is reached from its parent (field name or list index);
 * `marks` receives the structure as it is written (see outline.ts).
 */
function* write(
	node: Node,
	depth: number,
	opts: RenderOptions,
	style: JsonStyle,
	marks: Marks | undefined,
	seg: Seg
): Generator<string> {
	switch (node.k) {
		case 'scalar':
			if (typeof seg === 'number') marks?.leaf(seg);
			yield style.scalar(node.dtype, node.v);
			return;
		case 'str':
			if (typeof seg === 'number') marks?.leaf(seg);
			yield JSON.stringify(node.v);
			return;
		case 'enum':
			if (typeof seg === 'number') marks?.leaf(seg);
			yield style.enumToken(node.name);
			return;
		case 'bytes':
			if (style.bytesAsNumbers) {
				const v = node.v;
				yield* writeArray(
					{ k: 'array', dtype: 'uint8', length: v.length, get: (i) => v[i] },
					depth,
					opts,
					style,
					marks,
					seg
				);
				return;
			}
			if (typeof seg === 'number') marks?.leaf(seg);
			yield '"';
			yield* base64Chunks(node.v);
			yield '"';
			return;
		case 'array':
			yield* writeArray(node, depth, opts, style, marks, seg);
			return;
		case 'list': {
			const items = node.items;
			marks?.open('list', seg);
			if (items.length === 0) {
				yield '[]';
			} else if (items.length <= INLINE_LIST_MAX && items.every(isPrimitive)) {
				yield '[';
				for (let i = 0; i < items.length; i++) {
					if (i > 0) yield ', ';
					yield* write(items[i], depth + 1, opts, style, marks, i);
				}
				yield ']';
			} else {
				const pad = INDENT.repeat(depth + 1);
				yield '[\n';
				for (let i = 0; i < items.length; i++) {
					yield pad;
					yield* write(items[i], depth + 1, opts, style, marks, i);
					yield i < items.length - 1 ? ',\n' : '\n';
				}
				yield INDENT.repeat(depth) + ']';
			}
			marks?.close();
			return;
		}
		case 'obj': {
			const entries = node.entries;
			marks?.open('obj', seg);
			if (entries.length === 0) {
				yield '{}';
				marks?.close();
				return;
			}
			const pad = INDENT.repeat(depth + 1);
			yield '{\n';
			for (let i = 0; i < entries.length; i++) {
				const [key, value] = entries[i];
				yield pad + style.key(key) + ': ';
				yield* write(value, depth + 1, opts, style, marks, key);
				yield i < entries.length - 1 ? ',\n' : '\n';
			}
			yield INDENT.repeat(depth) + '}';
			marks?.close();
			return;
		}
	}
}

function* writeArray(
	node: ArrayNode,
	depth: number,
	opts: RenderOptions,
	style: JsonStyle,
	marks: Marks | undefined,
	seg: Seg
): Generator<string> {
	const { length, dtype, get } = node;
	if (length === 0) {
		marks?.open('array', seg, { length: 0, kept: 0, firstOffset: 0, perLine: 1 });
		yield '[]';
		marks?.close();
		return;
	}
	const kept = opts.truncateTo == null ? length : Math.min(length, Math.max(0, opts.truncateTo));
	const omitted = length - kept;

	if (omitted === 0 && length <= VALUES_PER_LINE) {
		marks?.open('array', seg, { length, kept, firstOffset: 0, perLine: length });
		const vals: string[] = [];
		for (let i = 0; i < length; i++) vals.push(style.scalar(dtype, get(i)));
		yield '[' + vals.join(', ') + ']';
		marks?.close();
		return;
	}

	marks?.open('array', seg, { length, kept, firstOffset: 1, perLine: VALUES_PER_LINE });
	const pad = INDENT.repeat(depth + 1);
	yield '[\n';
	for (let start = 0; start < kept; start += VALUES_PER_LINE) {
		const end = Math.min(start + VALUES_PER_LINE, kept);
		const vals: string[] = [];
		for (let i = start; i < end; i++) vals.push(style.scalar(dtype, get(i)));
		const more = end < kept || omitted > 0;
		yield pad + vals.join(', ') + (more ? ',\n' : '\n');
	}
	if (omitted > 0) yield pad + JSON.stringify(`... ${omitted} more values`) + '\n';
	yield INDENT.repeat(depth) + ']';
	marks?.close();
}

/** Build an output format with JSON's layout and the given token style. */
export function makeJsonLikeFormat(
	meta: Pick<OutputFormat, 'id' | 'label' | 'language'>,
	style: JsonStyle,
	bytesChars?: (byteLength: number, truncateTo: number | null) => number
): OutputFormat {
	return {
		...meta,
		truncate: { label: 'values of each tensor', defaultValue: TRUNCATE_TO },
		estimate: (ctx: RenderContext, opts: RenderOptions) =>
			estimateJsonChars(ctx.root, opts.truncateTo, 0, bytesChars),
		*serialize(ctx: RenderContext, opts: RenderOptions, marks?: Marks) {
			yield* write(ctx.root, 0, opts, style, marks, null);
			yield '\n';
		}
	};
}

export const jsonFormat: OutputFormat = makeJsonLikeFormat(
	{ id: 'json', label: 'JSON', language: 'json' },
	JSON_STYLE
);
