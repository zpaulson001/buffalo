import { describe, expect, it } from 'vitest';
import { jsonFormat } from '../../output/json';
import { prototextFormat } from '../../output/prototext';
import { tfliteFormat } from './index';
import { buildTflite } from './testing';

function decode(bytes: Uint8Array) {
	return tfliteFormat.decode(bytes);
}

function toJson(bytes: Uint8Array, truncateTo: number | null = null) {
	const root = decode(bytes);
	return JSON.parse([...jsonFormat.serialize({ root, bytes }, { truncateTo })].join(''));
}

describe('tflite', () => {
	const out = toJson(buildTflite());

	it('reads the model structure using the bundled schema', () => {
		expect(out.version).toBe(3);
		expect(out.description).toBe('test model');
		expect(out.operator_codes).toEqual([{ custom_code: 'MyOp' }]);
		const sg = out.subgraphs[0];
		expect(sg.name).toBe('main');
		expect(sg.inputs).toEqual([0]);
		expect(sg.tensors.map((t: { name: string }) => t.name)).toEqual([
			'input',
			'weights',
			'ids',
			'q',
			'text'
		]);
		expect(sg.tensors[2]).toEqual({ shape: [2], type: 'INT64', buffer: 2, name: 'ids' });
		// FLOAT32 is the default type, so it is omitted, as flatc does.
		expect(sg.tensors[0].type).toBeUndefined();
	});

	it('decodes buffers by the type and shape of the tensor that uses them', () => {
		const buffers = out.buffers;
		expect(buffers[0]).toEqual({}); // empty sentinel buffer
		expect(buffers[1].data.dtype).toBe('FLOAT32');
		expect(buffers[1].data.shape).toEqual([4]);
		expect(buffers[1].data.values).toHaveLength(4);
		expect(buffers[1].data.values[1]).toBeCloseTo(Math.sin(1) * 0.37, 6);
		expect(buffers[2].data).toMatchObject({
			dtype: 'INT64',
			shape: [2],
			values: ['1', '9007199254740993']
		});
		expect(buffers[3].data.values).toEqual([-128, 0, 127]);
	});

	it('keeps undecodable buffers as base64', () => {
		expect(Buffer.from(out.buffers[4].data, 'base64')).toEqual(Buffer.from([1, 2, 3, 4, 5]));
	});

	it('truncates decoded tensors like ONNX ones', () => {
		const big = toJson(buildTflite({ weightCount: 1000 }), 10);
		expect(big.buffers[1].data.values).toHaveLength(11);
		expect(big.buffers[1].data.values[10]).toBe('... 990 more values');
	});

	it('renders as prototext too', () => {
		const bytes = buildTflite();
		const text = [
			...prototextFormat.serialize({ root: decode(bytes), bytes }, { truncateTo: null })
		].join('');
		expect(text).toContain('version: 3\n');
		expect(text).toContain('type: INT64\n');
		expect(text).toMatch(/# decoded from bytes using tensor "weights"/);
	});

	it('rejects a file that is not a TFLite model', () => {
		const bytes = buildTflite();
		bytes.set(new TextEncoder().encode('ONNX'), 4);
		expect(() => decode(bytes)).toThrow(/identifier "ONNX".*"TFL3"/);
	});
});
