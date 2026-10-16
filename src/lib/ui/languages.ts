import { json } from '@codemirror/lang-json';
import { foldService, StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { FoldIndex } from './foldIndex';

/** Minimal highlighter for protobuf text format and FlatBuffers text (fbt): comments, strings, numbers, keys, enum/bool atoms. */
const prototextLanguage = StreamLanguage.define<null>({
	token(stream) {
		if (stream.eatSpace()) return null;
		if (stream.match('#')) {
			stream.skipToEnd();
			return 'comment';
		}
		if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
		if (stream.match(/^-?(?:inf|nan)\b/i)) return 'number';
		if (stream.match(/^-?\d[\w.+-]*/)) return 'number';
		if (stream.match(/^[A-Za-z_][\w.]*(?=\s*[:{[])/)) return 'propertyName';
		if (stream.match(/^[A-Za-z_]\w*/)) return 'atom';
		stream.next();
		return null;
	}
});

const PROTO_KEYWORDS = new Set([
	'syntax',
	'package',
	'import',
	'option',
	'message',
	'enum',
	'service',
	'rpc',
	'returns',
	'extend',
	'extensions',
	'reserved',
	'oneof',
	'map',
	'repeated',
	'optional',
	'required',
	'to',
	'max',
	'stream',
	'public',
	'weak',
	'true',
	'false'
]);

const FBS_KEYWORDS = new Set([
	'table',
	'struct',
	'enum',
	'union',
	'namespace',
	'include',
	'attribute',
	'root_type',
	'file_identifier',
	'file_extension',
	'rpc_service',
	'native_include',
	'true',
	'false'
]);

const SCALAR_TYPES = new Set([
	'int32',
	'int64',
	'uint32',
	'uint64',
	'sint32',
	'sint64',
	'fixed32',
	'fixed64',
	'sfixed32',
	'sfixed64',
	'float',
	'double',
	'bool',
	'string',
	'bytes',
	'byte',
	'ubyte',
	'short',
	'ushort',
	'int',
	'uint',
	'long',
	'ulong',
	'int8',
	'uint8',
	'int16',
	'uint16',
	'float32',
	'float64'
]);

/** Highlighter for .proto and .fbs source: comments (incl. block), strings, numbers, keywords, scalar types. */
function schemaLanguage(keywords: Set<string>) {
	return StreamLanguage.define<{ inComment: boolean }>({
		startState: () => ({ inComment: false }),
		token(stream, state) {
			if (state.inComment) {
				if (stream.skipTo('*/')) {
					stream.match('*/');
					state.inComment = false;
				} else {
					stream.skipToEnd();
				}
				return 'comment';
			}
			if (stream.eatSpace()) return null;
			if (stream.match('//')) {
				stream.skipToEnd();
				return 'comment';
			}
			if (stream.match('/*')) {
				state.inComment = true;
				return 'comment';
			}
			if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) {
				return 'string';
			}
			if (stream.match(/^-?\d[\w.]*/)) return 'number';
			if (stream.match(/^[A-Za-z_][\w.]*/)) {
				const word = stream.current();
				if (keywords.has(word)) return 'keyword';
				return SCALAR_TYPES.has(word) ? 'typeName' : null;
			}
			stream.next();
			return null;
		}
	});
}

const protoLanguage = schemaLanguage(PROTO_KEYWORDS);
const fbsLanguage = schemaLanguage(FBS_KEYWORDS);

/** Folding of `{ … }` blocks, via the incrementally built index (see foldIndex.ts). */
function indexedFolding(index: FoldIndex): Extension {
	return foldService.of((state, lineStart) => {
		const line = state.doc.lineAt(lineStart);
		const close = index.closeOf(line.number);
		if (close === undefined || close > state.doc.lines) return null;
		const closeLine = state.doc.line(close);
		const indent = closeLine.text.length - closeLine.text.trimStart().length;
		const to = closeLine.from + indent;
		return to > line.to ? { from: line.to, to } : null;
	});
}

/** Editor language per output language id (or schema language). Hex is plain text. */
export function languageExtension(language: string, foldIndex: FoldIndex): Extension {
	switch (language) {
		case 'json':
			// The JSON parser only works near the viewport, and CodeMirror won't offer a fold for a
			// block that reaches past what's parsed, so big enclosing blocks would have no arrow.
			// The line index knows every block's end as soon as its text has streamed in.
			return [json(), indexedFolding(foldIndex)];
		case 'prototext':
		case 'fbt': // same token shapes: bare keys, strings, numbers, bare enum names
			return [prototextLanguage, indexedFolding(foldIndex)];
		case 'proto':
			return [protoLanguage, indexedFolding(foldIndex)];
		case 'fbs':
			return [fbsLanguage, indexedFolding(foldIndex)];
		default:
			return [];
	}
}
