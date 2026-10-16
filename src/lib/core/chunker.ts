/** Re-batch many small strings into chunks of at least `minChars` characters. */
export function* chunked(source: Iterable<string>, minChars: number): Generator<string> {
	let parts: string[] = [];
	let size = 0;
	for (const s of source) {
		parts.push(s);
		size += s.length;
		if (size >= minChars) {
			yield parts.join('');
			parts = [];
			size = 0;
		}
	}
	if (size > 0) yield parts.join('');
}
