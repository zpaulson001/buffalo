import * as flatbuffers from 'flatbuffers';

/**
 * Test helper: builds a small .tflite with the official FlatBuffers Builder,
 * following the vtable slots of the bundled schema.fbs. Uses only erasable
 * TypeScript so it can also be run with `node --experimental-strip-types`.
 */

// TensorType values from schema.fbs
export const TensorType = { FLOAT32: 0, INT32: 2, INT64: 4, STRING: 5, INT8: 9 };

interface TensorSpec {
	name: string;
	shape: number[];
	type: number;
	buffer: number;
}

function tensor(b: flatbuffers.Builder, t: TensorSpec): number {
	const name = b.createString(t.name);
	b.startVector(4, t.shape.length, 4);
	for (const d of [...t.shape].reverse()) b.addInt32(d);
	const shape = b.endVector();
	b.startObject(4);
	b.addFieldOffset(0, shape, 0); // shape
	b.addFieldInt8(1, t.type, 0); // type (default FLOAT32 is omitted)
	b.addFieldInt32(2, t.buffer, 0); // buffer
	b.addFieldOffset(3, name, 0); // name
	return b.endObject();
}

function buffer(b: flatbuffers.Builder, data?: Uint8Array): number {
	const vec = data ? b.createByteVector(data) : 0;
	b.startObject(3);
	if (vec) b.addFieldOffset(0, vec, 0);
	return b.endObject();
}

function offsets(b: flatbuffers.Builder, items: number[]): number {
	b.startVector(4, items.length, 4);
	for (const o of [...items].reverse()) b.addOffset(o);
	return b.endVector();
}

export function buildTflite(opts: { weightCount?: number } = {}): Uint8Array {
	const weightCount = opts.weightCount ?? 4;
	const b = new flatbuffers.Builder(1024);

	const weights = new Float32Array(weightCount);
	for (let i = 0; i < weightCount; i++) weights[i] = Math.sin(i) * 0.37;
	const ids = new BigInt64Array([1n, 9007199254740993n]);
	const quant = new Int8Array([-128, 0, 127]);

	const buffers = offsets(b, [
		buffer(b), // buffer 0 is the empty sentinel
		buffer(b, new Uint8Array(weights.buffer)),
		buffer(b, new Uint8Array(ids.buffer)),
		buffer(b, new Uint8Array(quant.buffer)),
		buffer(b, new Uint8Array([1, 2, 3, 4, 5]))
	]);

	const tensors = offsets(b, [
		tensor(b, { name: 'input', shape: [1, 4], type: TensorType.FLOAT32, buffer: 0 }),
		tensor(b, { name: 'weights', shape: [weightCount], type: TensorType.FLOAT32, buffer: 1 }),
		tensor(b, { name: 'ids', shape: [2], type: TensorType.INT64, buffer: 2 }),
		tensor(b, { name: 'q', shape: [3], type: TensorType.INT8, buffer: 3 }),
		tensor(b, { name: 'text', shape: [1], type: TensorType.STRING, buffer: 4 })
	]);
	b.startVector(4, 1, 4);
	b.addInt32(0);
	const inputs = b.endVector();
	b.startVector(4, 1, 4);
	b.addInt32(1);
	const outputs = b.endVector();
	const sgName = b.createString('main');
	b.startObject(5);
	b.addFieldOffset(0, tensors, 0);
	b.addFieldOffset(1, inputs, 0);
	b.addFieldOffset(2, outputs, 0);
	b.addFieldOffset(4, sgName, 0);
	const subgraph = b.endObject();
	const subgraphs = offsets(b, [subgraph]);

	const custom = b.createString('MyOp');
	b.startObject(4);
	b.addFieldOffset(1, custom, 0); // custom_code
	const opcode = b.endObject();
	const opcodes = offsets(b, [opcode]);

	const description = b.createString('test model');
	b.startObject(5);
	b.addFieldInt32(0, 3, 0); // version
	b.addFieldOffset(1, opcodes, 0);
	b.addFieldOffset(2, subgraphs, 0);
	b.addFieldOffset(3, description, 0);
	b.addFieldOffset(4, buffers, 0);
	b.finish(b.endObject(), 'TFL3');
	return b.asUint8Array();
}
