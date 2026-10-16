import { customSchemaFormat, type SchemaSource } from './input/flatbuffers';
import { onnxFormat } from './input/onnx';
import { pteFormat } from './input/pte';
import { tfliteFormat } from './input/tflite';
import { fbtFormat } from './output/fbt';
import { hexFormat } from './output/hex';
import { jsonFormat } from './output/json';
import { prototextFormat } from './output/prototext';
import type { InputFormat, OutputFormat } from './types';

/** To add a format, write the module and add it to the matching list. */
export const inputFormats: InputFormat[] = [onnxFormat, tfliteFormat, pteFormat];
export const outputFormats: OutputFormat[] = [jsonFormat, prototextFormat, fbtFormat, hexFormat];

export function detectInputFormat(fileName: string): InputFormat | undefined {
	const name = fileName.toLowerCase();
	return inputFormats.find((f) => f.extensions.some((ext) => name.endsWith(ext)));
}

/**
 * Pick how to decode a file. A user-supplied FlatBuffers schema wins over the
 * file extension, so any FlatBuffers file can be read with its own .fbs.
 */
export function resolveInputFormat(
	fileName: string,
	schema?: SchemaSource[]
): InputFormat | undefined {
	return schema?.length ? customSchemaFormat(schema) : detectInputFormat(fileName);
}

export function getOutputFormat(id: string): OutputFormat | undefined {
	return outputFormats.find((f) => f.id === id);
}

export interface ViewableSchema {
	/** What reads with it, e.g. "ONNX (protobuf)". */
	source: string;
	fileName: string;
	language: 'proto' | 'fbs';
	text: string;
}

/** The schemas bundled with the input formats, for viewing. */
export function baseSchemas(): ViewableSchema[] {
	return inputFormats.flatMap((f) => (f.baseSchemas ?? []).map((s) => ({ source: f.label, ...s })));
}

export function supportedExtensions(): string[] {
	return inputFormats.flatMap((f) => f.extensions);
}
