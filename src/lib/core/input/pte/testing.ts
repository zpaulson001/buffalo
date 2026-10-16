import * as flatbuffers from 'flatbuffers';

/**
 * Test helper: builds small ExecuTorch .pte files with the official FlatBuffers
 * Builder, following the vtable slots of the bundled program.fbs. Uses only
 * erasable TypeScript so it can also run with `node --experimental-strip-types`.
 */

// ScalarType and KernelTypes values from the schemas
export const ScalarType = { BYTE: 0, INT: 3, LONG: 4, FLOAT: 6 };
const KERNEL_TENSOR = 5;

function offsets(b: flatbuffers.Builder, items: number[]): number {
	b.startVector(4, items.length, 4);
	for (const o of [...items].reverse()) b.addOffset(o);
	return b.endVector();
}

function tensorValue(
	b: flatbuffers.Builder,
	t: { type: number; sizes: number[]; dataBufferIdx: number }
): number {
	b.startVector(4, t.sizes.length, 4);
	for (const d of [...t.sizes].reverse()) b.addInt32(d);
	const sizes = b.endVector();
	b.startObject(10);
	b.addFieldInt8(0, t.type, 0); // scalar_type
	b.addFieldOffset(2, sizes, 0); // sizes
	b.addFieldInt32(5, t.dataBufferIdx, 0); // data_buffer_idx
	const tensor = b.endObject();
	b.startObject(2);
	b.addFieldInt8(0, KERNEL_TENSOR, 0); // val_type
	b.addFieldOffset(1, tensor, 0); // val
	return b.endObject();
}

function alignUp(n: number, a: number): number {
	return Math.ceil(n / a) * a;
}

export interface PteOptions {
	/** 'inline': constants in Program.constant_buffer. 'segment': after the FlatBuffer, via the extended header. */
	layout: 'inline' | 'segment';
	floatCount?: number;
}

export function buildPte(opts: PteOptions): Uint8Array {
	const floatCount = opts.floatCount ?? 6;
	const weights = new Float32Array(floatCount);
	for (let i = 0; i < floatCount; i++) weights[i] = Math.sin(i) * 0.37;
	const weightBytes = new Uint8Array(weights.buffer);
	const ids = new BigInt64Array([1n, 9007199254740993n]);
	const idBytes = new Uint8Array(ids.buffer);

	const b = new flatbuffers.Builder(1024);

	// Layout of the constant data: index 0 is reserved; weights are index 1, ids index 2.
	const segmentData = new Uint8Array(alignUp(16 + weightBytes.length, 16) + idBytes.length);
	const weightsAt = 16;
	const idsAt = alignUp(16 + weightBytes.length, 16);
	segmentData.set(weightBytes, weightsAt);
	segmentData.set(idBytes, idsAt);

	const values = offsets(b, [
		tensorValue(b, { type: ScalarType.FLOAT, sizes: [2, 3], dataBufferIdx: 0 }), // an activation
		tensorValue(b, { type: ScalarType.FLOAT, sizes: [floatCount], dataBufferIdx: 1 }),
		tensorValue(b, { type: ScalarType.LONG, sizes: [2], dataBufferIdx: 2 })
	]);
	const planName = b.createString('forward');
	b.startObject(10);
	b.addFieldOffset(0, planName, 0);
	b.addFieldOffset(2, values, 0);
	const plan = b.endObject();
	const plans = offsets(b, [plan]);

	let constantBuffer = 0;
	let segments = 0;
	let constantSegment = 0;
	if (opts.layout === 'inline') {
		const bufs: number[] = [];
		for (const data of [new Uint8Array(0), weightBytes, idBytes]) {
			const storage = b.createByteVector(data);
			b.startObject(1);
			b.addFieldOffset(0, storage, 0);
			bufs.push(b.endObject());
		}
		constantBuffer = offsets(b, bufs);
	} else {
		b.startObject(2);
		b.addFieldInt64(0, 0n, 0n); // offset (relative to the segment base)
		b.addFieldInt64(1, BigInt(segmentData.length), 0n); // size
		segments = offsets(b, [b.endObject()]);
		b.startVector(8, 3, 8);
		b.addInt64(BigInt(idsAt));
		b.addInt64(BigInt(weightsAt));
		b.addInt64(0n);
		const offs = b.endVector();
		b.startObject(2);
		b.addFieldOffset(1, offs, 0); // offsets (segment_index 0 is the default)
		constantSegment = b.endObject();
	}

	b.startObject(8);
	b.addFieldInt32(0, 0, 0); // version
	b.addFieldOffset(1, plans, 0); // execution_plan
	if (constantBuffer) b.addFieldOffset(2, constantBuffer, 0);
	if (segments) b.addFieldOffset(4, segments, 0);
	if (constantSegment) b.addFieldOffset(5, constantSegment, 0);
	b.finish(b.endObject(), 'ET12');
	const flat = b.asUint8Array();

	if (opts.layout === 'inline') return flat;

	// Insert the extended header after the root offset and identifier, as ExecuTorch does.
	const HEADER_LENGTH = 32;
	const programSize = flat.length + HEADER_LENGTH;
	const segmentBase = alignUp(programSize, 128);
	const out = new Uint8Array(segmentBase + segmentData.length);
	out.set(flat.subarray(0, 8), 0);
	out.set(flat.subarray(8), 8 + HEADER_LENGTH);
	const dv = new DataView(out.buffer);
	dv.setUint32(
		0,
		new DataView(flat.buffer, flat.byteOffset).getUint32(0, true) + HEADER_LENGTH,
		true
	);
	out.set(new TextEncoder().encode('eh00'), 8);
	dv.setUint32(12, HEADER_LENGTH, true);
	dv.setBigUint64(16, BigInt(programSize), true);
	dv.setBigUint64(24, BigInt(segmentBase), true);
	dv.setBigUint64(32, BigInt(segmentData.length), true);
	out.set(segmentData, segmentBase);
	return out;
}
