import type { DType, Node } from '../../model';
import { rawToArray } from '../../rawarray';
import { asList, asObj, get } from '../nodeutil';

/** TFLite TensorType names we can decode from a buffer. Others stay base64. */
const TFLITE_DTYPES: Record<string, { dtype: DType; size: number }> = {
	FLOAT32: { dtype: 'float32', size: 4 },
	FLOAT16: { dtype: 'float16', size: 2 },
	INT32: { dtype: 'int32', size: 4 },
	UINT8: { dtype: 'uint8', size: 1 },
	INT64: { dtype: 'int64', size: 8 },
	BOOL: { dtype: 'bool', size: 1 },
	INT16: { dtype: 'int16', size: 2 },
	INT8: { dtype: 'int8', size: 1 },
	FLOAT64: { dtype: 'float64', size: 8 },
	UINT64: { dtype: 'uint64', size: 8 },
	UINT32: { dtype: 'uint32', size: 4 },
	UINT16: { dtype: 'uint16', size: 2 },
	BFLOAT16: { dtype: 'bfloat16', size: 2 }
};

/**
 * TFLite keeps constant data in `Model.buffers[i].data` and describes it
 * (type, shape, name) in `SubGraph.tensors`. Decode each buffer using the first
 * tensor that references it and put the result in the Buffer's `data` field,
 * along with the tensor's type and shape, so values sit next to their dims.
 * Buffers nobody references, or with types we can't decode, are left as bytes.
 */
export function decodeTfliteTensors(root: Node): void {
	const model = asObj(root);
	if (!model) return;
	const buffers = asList(get(model, 'buffers'));
	const done = new Set<number>();

	for (const subgraph of asList(get(model, 'subgraphs'))) {
		for (const tensor of asList(get(asObj(subgraph)!, 'tensors'))) {
			const t = asObj(tensor);
			if (!t) continue;
			const bufferNode = get(t, 'buffer');
			const index = bufferNode?.k === 'scalar' ? Number(bufferNode.v) : 0;
			if (index <= 0 || done.has(index)) continue;

			const buffer = asObj(buffers[index]);
			const dataIndex = buffer?.entries.findIndex(([k]) => k === 'data') ?? -1;
			const data = buffer && dataIndex >= 0 ? buffer.entries[dataIndex][1] : undefined;
			if (!buffer || data?.k !== 'bytes') continue;

			// `type` is omitted when it has its default value, FLOAT32.
			const typeNode = get(t, 'type');
			const typeName = typeNode?.k === 'enum' ? typeNode.name : 'FLOAT32';
			const info = TFLITE_DTYPES[typeName];
			const values = info && rawToArray(data.v, info);
			if (!values) continue;

			const nameNode = get(t, 'name');
			const tensorName = nameNode?.k === 'str' ? nameNode.v : undefined;
			const shape = get(t, 'shape');
			const entries: [string, Node][] = [['dtype', { k: 'str', v: typeName }]];
			if (shape) entries.push(['shape', shape]);
			entries.push(['values', values]);
			buffer.entries[dataIndex] = [
				'data',
				{
					k: 'obj',
					note: `decoded from bytes using tensor${tensorName ? ` "${tensorName}"` : ''} (type and shape come from the tensor)`,
					entries
				}
			];
			done.add(index);
		}
	}
}
