import protobuf from 'protobufjs';
import protoSource from './onnx.proto?raw';
import type { InputFormat } from '../../types';
import { messageToNode, type FieldHook, type Hooks } from '../protobuf';
import { ONNX_DTYPES, rawToArray } from './tensor';

/** data_type / elem_type are plain int32 in onnx.proto; show them by their DataType name. */
const dataTypeName: FieldHook = (msg, field) => {
	if (field.name !== 'data_type' && field.name !== 'elem_type') return undefined;
	const num = msg[field.name] as number;
	const dataType = field.root.lookupEnum('onnx.TensorProto.DataType');
	return {
		name: field.name,
		node: { k: 'enum', name: dataType.valuesById[num] ?? String(num), num }
	};
};

const hooks: Hooks = {
	'.onnx.TypeProto.Tensor': dataTypeName,
	'.onnx.TypeProto.SparseTensor': dataTypeName,
	/** Decode TensorProto.raw_data into numbers according to data_type. */
	'.onnx.TensorProto': (msg, field) => {
		if (field.name === 'data_type') return dataTypeName(msg, field);
		if (field.name !== 'raw_data') return undefined;
		const info = ONNX_DTYPES[msg.data_type as number];
		const values = info && rawToArray(msg.raw_data as Uint8Array, info);
		// Unsupported dtype or ragged length: fall back to base64 of the raw bytes.
		if (!info || !values) return undefined;
		return {
			name: 'data',
			node: {
				k: 'obj',
				note: 'decoded from raw_data (not a field of onnx.TensorProto)',
				entries: [
					['dtype', { k: 'str', v: info.name }],
					['values', values]
				]
			}
		};
	}
};

let modelType: protobuf.Type | undefined;

function getModelType(): protobuf.Type {
	if (!modelType) {
		// keepCase: field names stay as in onnx.proto (raw_data, not rawData).
		const { root } = protobuf.parse(protoSource, { keepCase: true });
		root.resolveAll();
		modelType = root.lookupType('onnx.ModelProto');
	}
	return modelType;
}

export const onnxFormat: InputFormat = {
	id: 'onnx',
	label: 'ONNX (protobuf)',
	baseSchemas: [{ fileName: 'onnx.proto', language: 'proto', text: protoSource }],
	extensions: ['.onnx'],
	decode(bytes) {
		const type = getModelType();
		return messageToNode(type, type.decode(bytes) as unknown as Record<string, unknown>, hooks);
	}
};
