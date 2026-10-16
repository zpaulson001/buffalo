/**
 * Format-neutral value tree. Input formats produce it, output formats walk it.
 * Large numeric data is represented lazily (`array`) so we never materialise a
 * JS array with one entry per tensor element.
 */

export type DType =
	| 'float16'
	| 'bfloat16'
	| 'float32'
	| 'float64'
	| 'int8'
	| 'int16'
	| 'int32'
	| 'int64'
	| 'uint8'
	| 'uint16'
	| 'uint32'
	| 'uint64'
	| 'bool';

/** 64-bit values are `number` when exactly representable, `bigint` otherwise. */
export type ScalarValue = number | bigint | boolean;

export type Node =
	| { k: 'scalar'; dtype: DType; v: ScalarValue }
	| { k: 'str'; v: string }
	| { k: 'bytes'; v: Uint8Array }
	| { k: 'enum'; name: string; num: number }
	| { k: 'list'; items: Node[] }
	/** `note` explains a synthetic object (not a real field); text outputs may show it as a comment. */
	| { k: 'obj'; entries: [key: string, value: Node][]; note?: string }
	| { k: 'array'; dtype: DType; length: number; get(i: number): ScalarValue };

export type ArrayNode = Extract<Node, { k: 'array' }>;

export function isWide(dtype: DType): boolean {
	return dtype === 'int64' || dtype === 'uint64';
}

/** Combine two 32-bit halves into a number if exact, else a bigint. */
export function int64FromParts(lo: number, hi: number, unsigned: boolean): number | bigint {
	if (unsigned ? hi < 0x200000 : hi >= -0x200000 && hi < 0x200000) {
		return hi * 4294967296 + lo;
	}
	return (BigInt(hi) << 32n) + BigInt(lo);
}
