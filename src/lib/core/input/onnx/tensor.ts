import type { DType } from '../../model';

export { rawToArray } from '../../rawarray';

export interface OnnxDType {
	/** Enum name from onnx.proto TensorProto.DataType. */
	name: string;
	dtype: DType;
	/** Bytes per element. */
	size: number;
}

/** TensorProto.DataType values we can decode from raw_data. */
export const ONNX_DTYPES: Record<number, OnnxDType> = {
	1: { name: 'FLOAT', dtype: 'float32', size: 4 },
	2: { name: 'UINT8', dtype: 'uint8', size: 1 },
	3: { name: 'INT8', dtype: 'int8', size: 1 },
	4: { name: 'UINT16', dtype: 'uint16', size: 2 },
	5: { name: 'INT16', dtype: 'int16', size: 2 },
	6: { name: 'INT32', dtype: 'int32', size: 4 },
	7: { name: 'INT64', dtype: 'int64', size: 8 },
	9: { name: 'BOOL', dtype: 'bool', size: 1 },
	10: { name: 'FLOAT16', dtype: 'float16', size: 2 },
	11: { name: 'DOUBLE', dtype: 'float64', size: 8 },
	12: { name: 'UINT32', dtype: 'uint32', size: 4 },
	13: { name: 'UINT64', dtype: 'uint64', size: 8 }, // 14+: complex, fp8, int4... not decoded
	16: { name: 'BFLOAT16', dtype: 'bfloat16', size: 2 }
};
