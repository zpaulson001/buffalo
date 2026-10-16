import programSource from './program.fbs?raw';
import scalarTypeSource from './scalar_type.fbs?raw';
import { createFlatbuffersFormat } from '../flatbuffers';
import { decodePteTensors } from './tensors';

const schemas = [
	{ fileName: 'program.fbs', language: 'fbs' as const, text: programSource },
	{ fileName: 'scalar_type.fbs', language: 'fbs' as const, text: scalarTypeSource }
];

/** ExecuTorch programs, read with the bundled official schemas (ExecuTorch v1.5.1). */
export const pteFormat = createFlatbuffersFormat(
	schemas.map((s) => ({ name: s.fileName, text: s.text })),
	{
		id: 'pte',
		label: 'ExecuTorch (FlatBuffers)',
		extensions: ['.pte'],
		baseSchemas: schemas,
		postProcess: decodePteTensors
	}
);
