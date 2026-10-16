import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { FoldIndex } from '../ui/foldIndex';
import { baseSchemas } from './formats';
import { parseSchema } from './input/flatbuffers/schema';

describe('baseSchemas', () => {
	const schemas = baseSchemas();

	it('lists the bundled ONNX and TFLite schemas', () => {
		expect(schemas.map((s) => [s.fileName, s.language])).toEqual([
			['onnx.proto', 'proto'],
			['schema.fbs', 'fbs'],
			['program.fbs', 'fbs'],
			['scalar_type.fbs', 'fbs']
		]);
		expect(schemas.map((s) => s.source)).toEqual([
			'ONNX (protobuf)',
			'TensorFlow Lite (FlatBuffers)',
			'ExecuTorch (FlatBuffers)',
			'ExecuTorch (FlatBuffers)'
		]);
	});

	it('carries the exact text the decoders use', () => {
		const [proto, fbs] = schemas;
		expect(proto.text).toContain('message ModelProto');
		expect(() => protobuf.parse(proto.text, { keepCase: true })).not.toThrow();
		expect(fbs.text).toContain('root_type Model;');
		expect(parseSchema([{ name: fbs.fileName, text: fbs.text }]).rootType?.name).toBe(
			'tflite.Model'
		);
	});
});

describe('schema folding', () => {
	it('indexes blocks in the real schema files', () => {
		const keywords: Record<string, string> = {
			'onnx.proto': 'message ModelProto {',
			'schema.fbs': 'table Model {',
			'program.fbs': 'table Program {',
			'scalar_type.fbs': 'enum ScalarType : byte {'
		};
		for (const s of baseSchemas()) {
			const index = new FoldIndex();
			index.push(s.text);
			const lines = s.text.split('\n');
			const keyword = keywords[s.fileName];
			const start = lines.findIndex((l) => l.startsWith(keyword)) + 1;
			expect(start).toBeGreaterThan(0);
			const end = index.closeOf(start);
			expect(end).toBeGreaterThan(start);
			expect(lines[end! - 1].startsWith('}')).toBe(true);
		}
	});
});
