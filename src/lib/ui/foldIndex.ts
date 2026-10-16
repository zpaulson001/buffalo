/**
 * Indentation-based fold index for pretty-printed text (prototext).
 *
 * Built incrementally as text is appended, in O(n) overall, so folding a block
 * never has to scan ahead through millions of lines. A block opens on a line
 * ending in `{` or `[` and closes on the next line, at the same indent, that
 * starts with `}` or `]`.
 */
export class FoldIndex {
	/** 1-based start line -> 1-based closing line. */
	private ends = new Map<number, number>();
	private stack: number[] = [];
	private lineNo = 0;
	/** Trailing text of the previous chunk that has no newline yet. */
	private partial = '';

	reset(): void {
		this.ends.clear();
		this.stack = [];
		this.lineNo = 0;
		this.partial = '';
	}

	push(text: string): void {
		const lines = (this.partial + text).split('\n');
		this.partial = lines.pop() ?? '';
		for (const line of lines) this.line(line);
	}

	private line(text: string): void {
		this.lineNo++;
		const trimmed = text.trimStart();
		const first = trimmed.charCodeAt(0);
		// `}` = 125, `]` = 93
		if ((first === 125 || first === 93) && this.stack.length) {
			this.ends.set(this.stack.pop()!, this.lineNo);
		}
		const last = trimmed.charCodeAt(trimmed.length - 1);
		// `{` = 123, `[` = 91; a closing line like `} {` is not produced by our serializers.
		if (last === 123 || last === 91) this.stack.push(this.lineNo);
	}

	/** Closing line of the block opened on `startLine`, if any. */
	closeOf(startLine: number): number | undefined {
		return this.ends.get(startLine);
	}
}
