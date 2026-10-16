import { CHARS_PER_VALUE } from '../estimate';
import { textScalar } from '../numfmt';
import { makeJsonLikeFormat, type JsonStyle } from './json';

/**
 * FlatBuffers text format, as printed by `flatc --json` without --strict-json:
 * JSON layout, but field names are bare identifiers, enums are bare names,
 * 64-bit integers are plain numbers, non-finite floats are nan/inf, and byte
 * vectors are lists of numbers.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const FBT_STYLE: JsonStyle = {
	key: (name) => (IDENTIFIER.test(name) ? name : JSON.stringify(name)),
	scalar: textScalar,
	// Names that aren't identifiers (e.g. an unknown value "5" or a flag set) stay quoted.
	enumToken: (name) => (IDENTIFIER.test(name) ? name : JSON.stringify(name)),
	bytesAsNumbers: true
};

export const fbtFormat = makeJsonLikeFormat(
	{ id: 'fbt', label: 'FBT', language: 'fbt' },
	FBT_STYLE,
	// Bytes become a number list, so they truncate like any other array.
	(n, truncateTo) => {
		const kept = truncateTo == null ? n : Math.min(n, truncateTo);
		return kept * CHARS_PER_VALUE.uint8 + 40;
	}
);
