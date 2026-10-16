import { describe, expect, it } from 'vitest';
import { ONNX_DTYPES, rawToArray } from './tensor';

function values(raw: Uint8Array, dt: number) {
	const arr = rawToArray(raw, ONNX_DTYPES[dt])!;
	return Array.from({ length: arr.length }, (_, i) => arr.get(i));
}

function bytesOf(build: (dv: DataView) => void, size: number): Uint8Array {
	const buf = new ArrayBuffer(size);
	build(new DataView(buf));
	return new Uint8Array(buf);
}

describe('rawToArray', () => {
	it('decodes little-endian float32', () => {
		const raw = bytesOf((dv) => {
			dv.setFloat32(0, 1.5, true);
			dv.setFloat32(4, -2, true);
		}, 8);
		expect(values(raw, 1)).toEqual([1.5, -2]);
	});

	it('decodes int64 exactly, switching to bigint beyond 2^53', () => {
		const raw = bytesOf((dv) => {
			dv.setBigInt64(0, -5n, true);
			dv.setBigInt64(8, 9007199254740993n, true); // 2^53 + 1
			dv.setBigInt64(16, -9223372036854775808n, true);
		}, 24);
		expect(values(raw, 7)).toEqual([-5, 9007199254740993n, -9223372036854775808n]);
	});

	it('decodes uint64 above the int64 range', () => {
		const raw = bytesOf((dv) => dv.setBigUint64(0, 18446744073709551615n, true), 8);
		expect(values(raw, 13)).toEqual([18446744073709551615n]);
	});

	it('decodes small ints, bool, float16, bfloat16 and double', () => {
		expect(values(new Uint8Array([1, 255]), 3)).toEqual([1, -1]);
		expect(values(new Uint8Array([1, 255]), 2)).toEqual([1, 255]);
		expect(values(new Uint8Array([0, 2]), 9)).toEqual([false, true]);
		expect(values(new Uint8Array([0x00, 0x3c, 0x00, 0xc0]), 10)).toEqual([1, -2]);
		expect(values(new Uint8Array([0x80, 0x3f]), 16)).toEqual([1]);
		expect(
			values(
				bytesOf((dv) => dv.setFloat64(0, Math.PI, true), 8),
				11
			)
		).toEqual([Math.PI]);
		expect(
			values(
				bytesOf((dv) => dv.setInt32(0, -123456, true), 4),
				6
			)
		).toEqual([-123456]);
	});

	it('works on unaligned views', () => {
		const buf = new Uint8Array(9);
		new DataView(buf.buffer).setFloat32(1, 0.25, true);
		expect(values(buf.subarray(1, 5), 1)).toEqual([0.25]);
	});

	it('rejects ragged lengths', () => {
		expect(rawToArray(new Uint8Array(5), ONNX_DTYPES[1])).toBeNull();
	});
});
