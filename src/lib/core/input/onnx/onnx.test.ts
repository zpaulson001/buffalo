import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import protoSource from './onnx.proto?raw';
import { jsonFormat } from '../../output/json';
import { onnxFormat } from './index';

const { root } = protobuf.parse(protoSource, { keepCase: true });
const ModelProto = root.lookupType('onnx.ModelProto');

function encode(obj: object): Uint8Array {
	return ModelProto.encode(ModelProto.fromObject(obj)).finish();
}

function f32(...vals: number[]): Uint8Array {
	return new Uint8Array(new Float32Array(vals).buffer);
}

function toJson(bytes: Uint8Array, truncateTo: number | null = null) {
	const node = onnxFormat.decode(bytes);
	const text = [...jsonFormat.serialize({ root: node, bytes }, { truncateTo })].join('');
	return JSON.parse(text);
}

describe('onnx decode -> json', () => {
	const model = encode({
		ir_version: '9007199254740993',
		producer_name: 'test',
		opset_import: [{ domain: '', version: 17 }],
		graph: {
			name: 'g',
			initializer: [
				{ name: 'w', dims: [2, 2], data_type: 1, raw_data: f32(1, 0.1, -3.5, 4) },
				{ name: 'legacy', dims: [3], data_type: 1, float_data: [0.5, 1.5, 2.5] },
				{
					name: 'big',
					dims: [2],
					data_type: 7,
					int64_data: ['9007199254740993', '-9223372036854775808']
				},
				{
					name: 'idx',
					dims: [2],
					data_type: 7,
					raw_data: new Uint8Array(new BigInt64Array([42n, 9007199254740993n]).buffer)
				},
				{ name: 'weird', dims: [1], data_type: 22, raw_data: new Uint8Array([1, 2]) }
			]
		}
	});

	it('keeps proto field names and emits int64 as strings', () => {
		const out = toJson(model);
		expect(out.ir_version).toBe('9007199254740993');
		expect(out.producer_name).toBe('test');
		expect(out.opset_import[0].version).toBe('17');
		expect(out.graph.initializer).toHaveLength(5);
	});

	it('decodes raw_data into data.values alongside dims', () => {
		const w = toJson(model).graph.initializer[0];
		expect(w.dims).toEqual(['2', '2']);
		expect(w.data_type).toBe('FLOAT');
		expect(w.raw_data).toBeUndefined();
		expect(w.data).toEqual({ dtype: 'FLOAT', values: [1, 0.1, -3.5, 4] });
	});

	it('outputs typed fields as-is', () => {
		const [, legacy, big] = toJson(model).graph.initializer;
		expect(legacy.float_data).toEqual([0.5, 1.5, 2.5]);
		expect(big.int64_data).toEqual(['9007199254740993', '-9223372036854775808']);
	});

	it('decodes int64 raw_data without precision loss', () => {
		const idx = toJson(model).graph.initializer[3];
		expect(idx.data).toEqual({ dtype: 'INT64', values: ['42', '9007199254740993'] });
	});

	it('falls back to base64 for dtypes it cannot decode', () => {
		const weird = toJson(model).graph.initializer[4];
		expect(weird.raw_data).toBe('AQI=');
		expect(weird.data).toBeUndefined();
	});

	it('truncates tensor values with a marker', () => {
		const big = encode({
			graph: {
				initializer: [
					{
						name: 'w',
						dims: [1000],
						data_type: 1,
						raw_data: new Uint8Array(new Float32Array(1000).buffer)
					}
				]
			}
		});
		const w = toJson(big, 10).graph.initializer[0];
		expect(w.data.values).toHaveLength(11);
		expect(w.data.values[10]).toBe('... 990 more values');
	});
});
