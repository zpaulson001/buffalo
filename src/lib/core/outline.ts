import { MAX_OUTLINE_RECORDS } from './config';

/**
 * Navigation index of the generated output text.
 *
 * Serializers report the structure they emit (`open`/`leaf`/`close`) while the
 * worker feeds every emitted string to `advance`. Because a generator only
 * resumes after its previous string was consumed, each mark is stamped with the
 * exact line it lands on, with no second layout algorithm to keep in sync.
 *
 * Records are stored in depth-first order in typed arrays (~21 bytes each), so
 * children of a record follow it directly and a subtree can be skipped in O(1).
 * Scalar tensor values get no records: their line is computed from the array's
 * layout. Scalar object fields get none either; the UI refines to them by key.
 */

/** A step in a path: a field name or an element index (null for the root). */
export type Seg = string | number | null;

export type MarkKind = 'obj' | 'list' | 'array';

/** Where an array's values sit in the text, relative to the array's first line. */
export interface ArrayLayout {
	length: number;
	/** Values actually printed (the rest are summarised by a marker line). */
	kept: number;
	/** 0 when values share the first line (`[1, 2, 3]`), 1 when they follow it. */
	firstOffset: number;
	perLine: number;
}

/** What a serializer reports as it writes. Optional: serializers must work without it. */
export interface Marks {
	/** The next character written begins a node. `seg` is its field name or index. */
	open(kind: MarkKind, seg: Seg, array?: ArrayLayout): void;
	/** A scalar list element starts here (it has no children). */
	leaf(seg: number): void;
	/** The node's last character was just written (before any separator or newline). */
	close(): void;
}

export type RecordKind = 'obj' | 'list' | 'array' | 'leaf';

const OBJ = 1;
const LIST = 2;
const ARRAY = 3;
const LEAF = 4;
const KIND_NAMES: RecordKind[] = ['obj', 'obj', 'list', 'array', 'leaf'];
const KIND_CODES: Record<MarkKind, number> = { obj: OBJ, list: LIST, array: ARRAY };

const UNCLOSED = 0x7fffffff;
/** Lists with more children than this get an index table on first lookup. */
const CHILD_TABLE_MIN = 64;

export class Outline implements Marks {
	/** Current output line (1-based): where the next character will land. */
	line = 1;
	/** True when the last character written was a newline. */
	private atLineStart = true;
	/** Set once the serializer finished; until then late records may be missing. */
	complete = false;
	/** True when MAX_OUTLINE_RECORDS was hit and some containers have no record. */
	overflowed = false;

	private n = 0;
	private capacity = 1024;
	private kind = new Uint8Array(this.capacity);
	private start = new Int32Array(this.capacity);
	private end = new Int32Array(this.capacity);
	private parent = new Int32Array(this.capacity);
	private seg = new Int32Array(this.capacity);
	/** Index of the first record after this record's subtree; 0 while still open. */
	private next = new Int32Array(this.capacity);
	private stack: number[] = [];
	private suppressed = 0;
	private keys: string[] = [];
	private keyIds = new Map<string, number>();
	private layouts = new Map<number, ArrayLayout>();
	private childTables = new Map<number, Int32Array>();

	get size(): number {
		return this.n;
	}

	/** Record id of the root, or -1 if nothing has been recorded. */
	get root(): number {
		return this.n > 0 ? 0 : -1;
	}

	// ------------------------------------------------------------------ building

	/** Account for text that was just written (call once per emitted string). */
	advance(text: string): void {
		if (text.length === 0) return;
		let i = text.indexOf('\n');
		while (i !== -1) {
			this.line++;
			i = text.indexOf('\n', i + 1);
		}
		this.atLineStart = text.charCodeAt(text.length - 1) === 10;
	}

	open(kind: MarkKind, seg: Seg, array?: ArrayLayout): void {
		this.add(KIND_CODES[kind], seg, array);
	}

	leaf(seg: number): void {
		if (this.add(LEAF, seg)) this.close();
	}

	close(): void {
		if (this.suppressed > 0) {
			this.suppressed--;
			return;
		}
		const id = this.stack.pop();
		if (id === undefined) return;
		// The node ends on the line of its last character, which is the previous
		// line if that character was a newline (as in prototext blocks).
		const last = this.atLineStart ? this.line - 1 : this.line;
		this.end[id] = Math.max(this.start[id], last);
		this.next[id] = this.n;
	}

	finish(): void {
		while (this.stack.length) this.close();
		this.complete = true;
	}

	private add(kind: number, seg: Seg, array?: ArrayLayout): boolean {
		if (this.suppressed > 0 || this.n >= MAX_OUTLINE_RECORDS) {
			this.overflowed = true;
			this.suppressed++;
			return false;
		}
		if (this.n === this.capacity) this.grow();
		const id = this.n++;
		this.kind[id] = kind;
		this.start[id] = this.line;
		this.end[id] = UNCLOSED;
		this.parent[id] = this.stack.length ? this.stack[this.stack.length - 1] : -1;
		this.seg[id] = this.encode(seg);
		this.next[id] = 0;
		if (array) this.layouts.set(id, array);
		this.stack.push(id);
		return true;
	}

	private grow(): void {
		this.capacity *= 2;
		const widen = <T extends Uint8Array | Int32Array>(a: T): T => {
			const b = new (a.constructor as new (n: number) => T)(this.capacity);
			b.set(a);
			return b;
		};
		this.kind = widen(this.kind);
		this.start = widen(this.start);
		this.end = widen(this.end);
		this.parent = widen(this.parent);
		this.seg = widen(this.seg);
		this.next = widen(this.next);
	}

	/** Non-negative: element index. -1: root. Below -1: interned field name. */
	private encode(seg: Seg): number {
		if (seg === null) return -1;
		if (typeof seg === 'number') return seg;
		let id = this.keyIds.get(seg);
		if (id === undefined) {
			id = this.keys.length;
			this.keys.push(seg);
			this.keyIds.set(seg, id);
		}
		return -(id + 2);
	}

	// ------------------------------------------------------------------- queries

	kindOf(id: number): RecordKind {
		return KIND_NAMES[this.kind[id]];
	}

	segOf(id: number): Seg {
		const s = this.seg[id];
		return s === -1 ? null : s >= 0 ? s : this.keys[-s - 2];
	}

	parentOf(id: number): number {
		return this.parent[id];
	}

	startOf(id: number): number {
		return this.start[id];
	}

	/** Last line of the record, or the current line if it is still being written. */
	endOf(id: number): number {
		return this.end[id] === UNCLOSED ? this.line : this.end[id];
	}

	isClosed(id: number): boolean {
		return this.end[id] !== UNCLOSED;
	}

	arrayLayout(id: number): ArrayLayout | undefined {
		return this.layouts.get(id);
	}

	firstChild(id: number): number {
		return id + 1 < this.n && this.parent[id + 1] === id ? id + 1 : -1;
	}

	nextSibling(id: number): number {
		const s = this.next[id];
		return s > 0 && s < this.n && this.parent[s] === this.parent[id] ? s : -1;
	}

	/** Child of `id` reached by field name (string) or index (number), or -1. */
	child(id: number, seg: string | number): number {
		if (typeof seg === 'number') return this.childAtIndex(id, seg);
		const keyId = this.keyIds.get(seg);
		if (keyId === undefined) return -1;
		const code = -(keyId + 2);
		for (let c = this.firstChild(id); c !== -1; c = this.nextSibling(c)) {
			if (this.seg[c] === code) return c;
		}
		return -1;
	}

	private childAtIndex(id: number, index: number): number {
		let table = this.childTables.get(id);
		if (!table && this.isClosed(id)) {
			const ids: number[] = [];
			for (let c = this.firstChild(id); c !== -1; c = this.nextSibling(c)) ids.push(c);
			if (ids.length >= CHILD_TABLE_MIN) {
				table = Int32Array.from(ids);
				this.childTables.set(id, table);
			} else {
				return index >= 0 && index < ids.length ? ids[index] : -1;
			}
		}
		if (table) return index >= 0 && index < table.length ? table[index] : -1;
		// Still streaming: walk.
		let i = 0;
		for (let c = this.firstChild(id); c !== -1; c = this.nextSibling(c)) {
			if (i++ === index) return c;
		}
		return -1;
	}

	childCount(id: number): number {
		let count = 0;
		for (let c = this.firstChild(id); c !== -1; c = this.nextSibling(c)) count++;
		return count;
	}

	/** Previous sibling (same parent, one index back), or -1. */
	prevSibling(id: number): number {
		const p = this.parent[id];
		const index = this.seg[id];
		return p >= 0 && index > 0 ? this.childAtIndex(p, index - 1) : -1;
	}

	/** Deepest record containing `line`, or -1. */
	deepestAt(line: number): number {
		let lo = 0;
		let hi = this.n - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (this.start[mid] <= line) {
				found = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		while (found >= 0 && this.end[found] < line) found = this.parent[found];
		return found;
	}

	/** Field names / indices from the root down to `id` (the root itself is omitted). */
	segments(id: number): (string | number)[] {
		const out: (string | number)[] = [];
		for (let r = id; r >= 0; r = this.parent[r]) {
			const s = this.segOf(r);
			if (s !== null) out.push(s);
		}
		return out.reverse();
	}

	/** Index labels for the lines in [from, to]: list elements and tensor value rows. */
	labels(from: number, to: number): [line: number, label: string][] {
		const out = new Map<number, string>();
		const addArrayRows = (id: number) => {
			const layout = this.layouts.get(id);
			if (!layout || layout.firstOffset === 0) return;
			const first = this.start[id] + layout.firstOffset;
			const rows = Math.ceil(layout.kept / layout.perLine);
			const lo = Math.max(0, from - first);
			const hi = Math.min(rows - 1, to - first);
			for (let k = lo; k <= hi; k++) out.set(first + k, `[${k * layout.perLine}]`);
		};

		// An array that began before the window may cover its top.
		const at = this.deepestAt(from);
		if (at >= 0 && this.kind[at] === ARRAY) addArrayRows(at);

		// First record starting at or after `from`.
		let lo = 0;
		let hi = this.n;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.start[mid] < from) lo = mid + 1;
			else hi = mid;
		}
		for (let id = lo; id < this.n && this.start[id] <= to; id++) {
			const s = this.seg[id];
			const p = this.parent[id];
			// Items of a list written on a single line (`["a", "b"]`) share it: no label for those.
			const ownLine = p >= 0 && this.end[p] !== this.start[p];
			if (s >= 0 && ownLine && !out.has(this.start[id])) out.set(this.start[id], `[${s}]`);
			if (this.kind[id] === ARRAY && id !== at) addArrayRows(id);
		}
		return [...out.entries()].sort((a, b) => a[0] - b[0]);
	}
}
