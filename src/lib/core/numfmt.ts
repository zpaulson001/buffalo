import { isWide, type DType, type ScalarValue } from './model';

const scratch = new DataView(new ArrayBuffer(8));

export function halfToNumber(h: number): number {
	const sign = h & 0x8000 ? -1 : 1;
	const exp = (h >> 10) & 0x1f;
	const man = h & 0x3ff;
	if (exp === 0) return sign * man * 2 ** -24;
	if (exp === 31) return man ? NaN : sign * Infinity;
	return sign * (1 + man / 1024) * 2 ** (exp - 15);
}

export function bfloat16ToNumber(h: number): number {
	scratch.setUint32(0, (h << 16) >>> 0);
	return scratch.getFloat32(0);
}

function roundHalfEven(v: number): number {
	const f = Math.floor(v);
	const d = v - f;
	if (d < 0.5) return f;
	if (d > 0.5) return f + 1;
	return f % 2 === 0 ? f : f + 1;
}

/** Round `x` to the nearest value with `mantBits` explicit mantissa bits. */
function roundToFormat(x: number, mantBits: number, minExp: number): number {
	if (!Number.isFinite(x) || x === 0) return x;
	scratch.setFloat64(0, Math.abs(x));
	let exp = ((scratch.getUint32(0) >>> 20) & 0x7ff) - 1023;
	if (exp < minExp) exp = minExp;
	const q = 2 ** (exp - mantBits);
	const r = roundHalfEven(Math.abs(x) / q) * q;
	return x < 0 ? -r : r;
}

type FloatKind = { maxDigits: number; roundtrips(candidate: number, x: number): boolean };

const FLOAT_KINDS: Partial<Record<DType, FloatKind>> = {
	float64: { maxDigits: 17, roundtrips: (c, x) => c === x },
	float32: { maxDigits: 9, roundtrips: (c, x) => Math.fround(c) === x },
	float16: { maxDigits: 5, roundtrips: (c, x) => roundToFormat(c, 10, -14) === x },
	bfloat16: { maxDigits: 4, roundtrips: (c, x) => roundToFormat(c, 7, -126) === x }
};

/**
 * Shortest decimal that parses back to exactly `x` in the given float format.
 * Round-trip success is monotonic in the digit count, so binary search.
 */
export function shortestFloat(x: number, dtype: DType): string {
	if (Number.isInteger(x) && Math.abs(x) < 1e15) return Object.is(x, -0) ? '-0' : String(x);
	const kind = FLOAT_KINDS[dtype]!;
	let lo = 1;
	let hi = kind.maxDigits;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (kind.roundtrips(Number(x.toPrecision(mid)), x)) hi = mid;
		else lo = mid + 1;
	}
	return String(Number(x.toPrecision(lo)));
}

/** A scalar as a protobuf text-format token: 64-bit ints bare, nan/inf lower-case. */
export function textScalar(dtype: DType, v: ScalarValue): string {
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (typeof v === 'bigint') return String(v);
	if (dtype === 'float16' || dtype === 'bfloat16' || dtype === 'float32' || dtype === 'float64') {
		if (Number.isNaN(v)) return 'nan';
		if (v === Infinity) return 'inf';
		if (v === -Infinity) return '-inf';
		return shortestFloat(v, dtype);
	}
	return String(v);
}

/** A scalar as a JSON token. int64/uint64 are strings; non-finite floats are strings. */
export function jsonScalar(dtype: DType, v: ScalarValue): string {
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (isWide(dtype)) return `"${v}"`;
	if (typeof v === 'bigint') return `"${v}"`;
	if (dtype === 'float16' || dtype === 'bfloat16' || dtype === 'float32' || dtype === 'float64') {
		if (Number.isNaN(v)) return '"NaN"';
		if (v === Infinity) return '"Infinity"';
		if (v === -Infinity) return '"-Infinity"';
		return shortestFloat(v, dtype);
	}
	return String(v);
}
