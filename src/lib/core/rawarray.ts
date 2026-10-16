import { bfloat16ToNumber, halfToNumber } from './numfmt';
import { int64FromParts, type ArrayNode, type DType } from './model';

/**
 * Lazily view little-endian `raw` bytes as `dtype` values. Uses DataView so
 * unaligned buffers and big-endian hosts are both fine. Returns null when the
 * byte length isn't a whole number of elements.
 */
export function rawToArray(
	raw: Uint8Array,
	info: { dtype: DType; size: number }
): ArrayNode | null {
	if (raw.length % info.size !== 0) return null;
	const length = raw.length / info.size;
	const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	let get: (i: number) => number | bigint | boolean;
	switch (info.dtype) {
		case 'float32':
			get = (i) => dv.getFloat32(i * 4, true);
			break;
		case 'float64':
			get = (i) => dv.getFloat64(i * 8, true);
			break;
		case 'float16':
			get = (i) => halfToNumber(dv.getUint16(i * 2, true));
			break;
		case 'bfloat16':
			get = (i) => bfloat16ToNumber(dv.getUint16(i * 2, true));
			break;
		case 'int8':
			get = (i) => dv.getInt8(i);
			break;
		case 'uint8':
			get = (i) => raw[i];
			break;
		case 'int16':
			get = (i) => dv.getInt16(i * 2, true);
			break;
		case 'uint16':
			get = (i) => dv.getUint16(i * 2, true);
			break;
		case 'int32':
			get = (i) => dv.getInt32(i * 4, true);
			break;
		case 'uint32':
			get = (i) => dv.getUint32(i * 4, true);
			break;
		case 'int64':
			get = (i) => int64FromParts(dv.getUint32(i * 8, true), dv.getInt32(i * 8 + 4, true), false);
			break;
		case 'uint64':
			get = (i) => int64FromParts(dv.getUint32(i * 8, true), dv.getUint32(i * 8 + 4, true), true);
			break;
		case 'bool':
			get = (i) => raw[i] !== 0;
			break;
	}
	return { k: 'array', dtype: info.dtype, length, get };
}
