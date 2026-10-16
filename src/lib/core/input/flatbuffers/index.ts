import type { Node } from '../../model';
import type { BaseSchema, InputFormat } from '../../types';
import { readFlatBuffer } from './reader';
import { parseSchema, type Schema, type SchemaSource } from './schema';

export type { SchemaSource } from './schema';

interface Options {
	id: string;
	label: string;
	extensions: string[];
	baseSchemas?: BaseSchema[];
	/** Format-specific touch-ups to the decoded tree (e.g. decoding tensor buffers); also gets the raw file bytes. */
	postProcess?: (root: Node, bytes: Uint8Array) => void;
}

/** An input format that reads FlatBuffers using the given .fbs sources. Parsed lazily. */
export function createFlatbuffersFormat(sources: SchemaSource[], opts: Options): InputFormat {
	let schema: Schema | undefined;
	return {
		id: opts.id,
		label: opts.label,
		extensions: opts.extensions,
		baseSchemas: opts.baseSchemas,
		decode(bytes) {
			schema ??= parseSchema(sources);
			const root = readFlatBuffer(schema, bytes);
			opts.postProcess?.(root, bytes);
			return root;
		}
	};
}

/** Format for a user-supplied schema: works for any extension. */
export function customSchemaFormat(sources: SchemaSource[]): InputFormat {
	const names = sources.map((s) => s.name).join(', ');
	return createFlatbuffersFormat(sources, {
		id: 'flatbuffers',
		label: `FlatBuffers (${names})`,
		extensions: []
	});
}
