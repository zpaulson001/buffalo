import { base64Length } from './base64';
import { INLINE_LIST_MAX, VALUES_PER_LINE } from './config';
import type { DType, Node } from './model';

/** Rough characters per value in JSON output, separator included. */
export const CHARS_PER_VALUE: Record<DType, number> = {
	float16: 9,
	bfloat16: 8,
	float32: 12,
	float64: 21,
	int8: 5,
	uint8: 5,
	int16: 7,
	uint16: 7,
	int32: 12,
	uint32: 12,
	int64: 14,
	uint64: 22,
	bool: 7
};

const TRUNCATION_MARKER_CHARS = 32;

/**
 * Estimated size of the pretty-printed JSON for `node`. Never walks tensor
 * elements. Text formats with the same shape (prototext) reuse it, differing
 * only in how many characters a `bytes` field takes (`bytesChars`).
 */
export function estimateJsonChars(
	node: Node,
	truncateTo: number | null,
	depth = 0,
	bytesChars: (byteLength: number, truncateTo: number | null) => number = (n) => base64Length(n) + 2
): number {
	const indent = 2 * depth;
	switch (node.k) {
		case 'scalar':
			return CHARS_PER_VALUE[node.dtype];
		case 'str':
			return node.v.length + 2;
		case 'enum':
			return node.name.length + 2;
		case 'bytes':
			return bytesChars(node.v.length, truncateTo);
		case 'list': {
			let total = 4 + indent;
			const inline = node.items.length <= INLINE_LIST_MAX;
			for (const item of node.items) {
				total +=
					estimateJsonChars(item, truncateTo, depth + 1, bytesChars) + (inline ? 2 : indent + 4);
			}
			return total;
		}
		case 'obj': {
			let total = 4 + indent;
			for (const [key, value] of node.entries) {
				total +=
					indent + 8 + key.length + estimateJsonChars(value, truncateTo, depth + 1, bytesChars);
			}
			return total;
		}
		case 'array': {
			const kept = truncateTo == null ? node.length : Math.min(node.length, truncateTo);
			const marker = kept < node.length ? TRUNCATION_MARKER_CHARS : 0;
			const lines = Math.ceil(kept / VALUES_PER_LINE) + 1;
			return kept * CHARS_PER_VALUE[node.dtype] + marker + lines * (indent + 6);
		}
	}
}
