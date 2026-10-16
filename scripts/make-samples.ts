/**
 * Generates small sample files for trying Buffalo without real models:
 *
 *   pnpm samples          writes samples/{small.onnx,model.tflite,segment.pte,inline.pte,data.bin,tiny.fbs}
 *   pnpm samples:big      also writes large files that trip the size guard
 *
 * Run with Node >= 22.13 (TypeScript is stripped by Node itself, see package.json).
 * Only erasable TypeScript syntax is allowed here.
 */
import * as flatbuffers from 'flatbuffers';
import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';
import { buildPte } from '../src/lib/core/input/pte/testing.ts';
import { buildTflite } from '../src/lib/core/input/tflite/testing.ts';

const big = process.argv.includes('--big');
const out = path.resolve(import.meta.dirname, '../samples');
fs.mkdirSync(out, { recursive: true });

function write(name: string, bytes: Uint8Array | string) {
	fs.writeFileSync(path.join(out, name), bytes);
	const size = typeof bytes === 'string' ? bytes.length : bytes.length;
	console.log(`  ${name} (${size.toLocaleString()} bytes)`);
}

// ONNX: encode a ModelProto with the bundled onnx.proto.
const proto = fs.readFileSync(
	path.resolve(import.meta.dirname, '../src/lib/core/input/onnx/onnx.proto'),
	'utf8'
);
const { root } = protobuf.parse(proto, { keepCase: true });
const ModelProto = root.lookupType('onnx.ModelProto');

function floats(count: number): Uint8Array {
	const a = new Float32Array(count);
	for (let i = 0; i < count; i++) a[i] = Math.sin(i) * 0.37;
	return new Uint8Array(a.buffer);
}

function onnx(tensors: object[]): Uint8Array {
	const model = ModelProto.fromObject({
		ir_version: 9,
		producer_name: 'buffalo-samples',
		opset_import: [{ domain: '', version: 17 }],
		graph: {
			name: 'g',
			node: [{ input: ['x', 'w'], output: ['y'], op_type: 'MatMul', name: 'mm' }],
			initializer: tensors
		}
	});
	return ModelProto.encode(model).finish();
}

console.log(`Writing samples to ${out}`);
write(
	'small.onnx',
	onnx([
		{ name: 'w', dims: [4, 3], data_type: 1, raw_data: floats(12) },
		{
			name: 'h',
			dims: [3],
			data_type: 10, // FLOAT16: 1, 0.1, -2
			raw_data: new Uint8Array([0x00, 0x3c, 0x66, 0x2e, 0x00, 0xc0])
		},
		{
			name: 'ids',
			dims: [2],
			data_type: 7, // INT64, one value above 2^53
			raw_data: new Uint8Array(new BigInt64Array([1n, 9007199254740993n]).buffer)
		}
	])
);

// FlatBuffers-based formats.
write('model.tflite', buildTflite({ weightCount: 40 }));
write('segment.pte', buildPte({ layout: 'segment', floatCount: 40 }));
write('inline.pte', buildPte({ layout: 'inline', floatCount: 6 }));

// A custom schema: drop tiny.fbs together with data.bin.
const b = new flatbuffers.Builder(64);
const s = b.createString('hello');
b.startObject(2);
b.addFieldInt32(0, 7, 0);
b.addFieldOffset(1, s, 0);
b.finish(b.endObject(), 'TINY');
write('data.bin', b.asUint8Array());
write('tiny.fbs', 'table T { v: int; s: string; }\nroot_type T;\nfile_identifier "TINY";\n');

if (big) {
	console.log('Large files (these trigger the size guard):');
	write(
		'huge.onnx',
		onnx([{ name: 'w', dims: [30_000_000], data_type: 1, raw_data: floats(30_000_000) }])
	);
	write('big.tflite', buildTflite({ weightCount: 20_000_000 }));
}
