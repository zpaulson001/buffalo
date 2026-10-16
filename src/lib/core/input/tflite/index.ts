import schemaSource from './schema.fbs?raw';
import { createFlatbuffersFormat } from '../flatbuffers';
import { decodeTfliteTensors } from './tensors';

/** TensorFlow Lite models, read with the bundled official schema (TensorFlow v2.21.0). */
export const tfliteFormat = createFlatbuffersFormat([{ name: 'schema.fbs', text: schemaSource }], {
	id: 'tflite',
	label: 'TensorFlow Lite (FlatBuffers)',
	extensions: ['.tflite'],
	baseSchemas: [{ fileName: 'schema.fbs', language: 'fbs', text: schemaSource }],
	postProcess: decodeTfliteTensors
});
