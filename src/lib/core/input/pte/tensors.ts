import type { DType, Node } from '../../model';
import { rawToArray } from '../../rawarray';
import { asList, asNumber, asObj, enumName, get } from '../nodeutil';

/** ExecuTorch ScalarType names we can decode. Quantized types are shown as their raw integers. */
const SCALAR_TYPES: Record<string, { dtype: DType; size: number }> = {
	BYTE: { dtype: 'uint8', size: 1 },
	CHAR: { dtype: 'int8', size: 1 },
	SHORT: { dtype: 'int16', size: 2 },
	INT: { dtype: 'int32', size: 4 },
	LONG: { dtype: 'int64', size: 8 },
	HALF: { dtype: 'float16', size: 2 },
	FLOAT: { dtype: 'float32', size: 4 },
	DOUBLE: { dtype: 'float64', size: 8 },
	BOOL: { dtype: 'bool', size: 1 },
	QINT8: { dtype: 'int8', size: 1 },
	QUINT8: { dtype: 'uint8', size: 1 },
	QINT32: { dtype: 'int32', size: 4 },
	BFLOAT16: { dtype: 'bfloat16', size: 2 },
	UINT16: { dtype: 'uint16', size: 2 },
	UINT32: { dtype: 'uint32', size: 4 },
	UINT64: { dtype: 'uint64', size: 8 }
};

/**
 * Optional header ExecuTorch inserts at byte 8 (right after the FlatBuffer's
 * root offset and `ET12` identifier): "eh00", header length (u32), program size
 * (u64), segment base offset (u64) and, in newer files, segment data size (u64).
 * Segment offsets in the schema are relative to the segment base offset.
 */
const HEADER_OFFSET = 8;

interface ExtendedHeader {
	programSize: number;
	segmentBaseOffset: number;
	segmentDataSize?: number;
}

export function readExtendedHeader(bytes: Uint8Array): ExtendedHeader | undefined {
	if (bytes.length < HEADER_OFFSET + 24) return undefined;
	const magic = String.fromCharCode(...bytes.subarray(HEADER_OFFSET, HEADER_OFFSET + 4));
	if (magic !== 'eh00') return undefined;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const length = dv.getUint32(HEADER_OFFSET + 4, true);
	if (length < 24 || HEADER_OFFSET + length > bytes.length) return undefined;
	const programSize = Number(dv.getBigUint64(HEADER_OFFSET + 8, true));
	const segmentBaseOffset = Number(dv.getBigUint64(HEADER_OFFSET + 16, true));
	if (!Number.isSafeInteger(programSize) || !Number.isSafeInteger(segmentBaseOffset)) {
		return undefined;
	}
	const segmentDataSize =
		length >= 32 ? Number(dv.getBigUint64(HEADER_OFFSET + 24, true)) : undefined;
	return { programSize, segmentBaseOffset, segmentDataSize };
}

function scalar(dtype: DType, v: number): Node {
	return { k: 'scalar', dtype, v };
}

/**
 * Decode constant tensors of an ExecuTorch Program into `data` fields next to
 * each Tensor's `sizes` and `scalar_type`. Constants live either inline in
 * `constant_buffer` (older files) or in a segment after the FlatBuffer, found
 * through the extended header and `constant_segment.offsets`.
 */
export function decodePteTensors(root: Node, bytes: Uint8Array): void {
	const program = asObj(root);
	if (!program) return;

	const header = readExtendedHeader(bytes);
	if (header) {
		const entries: [string, Node][] = [
			['program_size', scalar('uint64', header.programSize)],
			['segment_base_offset', scalar('uint64', header.segmentBaseOffset)]
		];
		if (header.segmentDataSize !== undefined) {
			entries.push(['segment_data_size', scalar('uint64', header.segmentDataSize)]);
		}
		program.entries.unshift([
			'extended_header',
			{
				k: 'obj',
				note: 'read from the .pte file header (not part of the FlatBuffer schema)',
				entries
			}
		]);
	}

	const buffers = asList(get(program, 'constant_buffer'));
	const segments = asList(get(program, 'segments')).map((s) => ({
		offset: asNumber(get(asObj(s), 'offset')) ?? 0,
		size: asNumber(get(asObj(s), 'size')) ?? 0
	}));
	const constants = asObj(get(program, 'constant_segment'));
	const constantOffsets = get(constants, 'offsets');
	const constantSegment = segments[asNumber(get(constants, 'segment_index')) ?? 0];

	for (const plan of asList(get(program, 'execution_plan'))) {
		for (const value of asList(get(asObj(plan), 'values'))) {
			const ev = asObj(value);
			if (enumName(get(ev, 'val_type')) !== 'Tensor') continue;
			const tensor = asObj(get(ev, 'val'));
			if (!tensor) continue;

			// Index 0 is reserved for non-constant tensors.
			const index = asNumber(get(tensor, 'data_buffer_idx')) ?? 0;
			if (index <= 0) continue;

			const typeName = enumName(get(tensor, 'scalar_type')) ?? 'BYTE'; // BYTE is the default
			const info = SCALAR_TYPES[typeName];
			if (!info) continue;

			const sizes = get(tensor, 'sizes');
			let count = 1;
			if (sizes?.k === 'array') {
				for (let i = 0; i < sizes.length; i++) count *= Number(sizes.get(i));
			}
			const length = count * info.size;
			if (!Number.isSafeInteger(length)) continue;

			let raw: Uint8Array | undefined;
			let where = '';
			const storage = get(asObj(buffers[index]), 'storage');
			if (storage?.k === 'bytes' && storage.v.length >= length) {
				raw = storage.v.subarray(0, length);
				where = `constant_buffer[${index}]`;
			} else if (header && constantSegment && constantOffsets?.k === 'array') {
				const offset = index < constantOffsets.length ? Number(constantOffsets.get(index)) : NaN;
				const start = header.segmentBaseOffset + constantSegment.offset + offset;
				if (offset + length <= constantSegment.size && start + length <= bytes.length) {
					raw = bytes.subarray(start, start + length);
					where = `segment at file offset ${start}`;
				}
			}
			const values = raw && rawToArray(raw, info);
			if (!values) continue;

			const at = tensor.entries.findIndex(([k]) => k === 'data_buffer_idx');
			tensor.entries.splice(at + 1, 0, [
				'data',
				{
					k: 'obj',
					note: `decoded from ${where} (not a field of the schema)`,
					entries: [
						['dtype', { k: 'str', v: typeName }],
						['values', values]
					]
				}
			]);
		}
	}
}
