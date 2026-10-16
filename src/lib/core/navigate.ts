import { NAME_KEYS, SEARCH_RESULT_LIMIT } from './config';
import type { Node } from './model';
import type { Outline } from './outline';

/**
 * Navigation over a rendered document. The decoded tree validates paths and
 * powers completion and name search; the Outline maps tree positions to lines of
 * output text. Everything here is plain data in / plain data out, so queries can
 * cross the worker boundary.
 */

// ------------------------------------------------------------------------ types

/** Where to scroll, and optionally which part of the element to select. */
export interface Refine {
	/** Select this scalar field of the target object (it has no record of its own). */
	key?: string;
	/** The target is the document root, whose first field may share its first line. */
	root?: boolean;
	/** Select one value of a tensor row; `header` when values share the array's first line. */
	value?: { offset: number; header: boolean };
}

export interface Target {
	line: number;
	endLine: number;
	/** Normalised path, e.g. `graph.node[12].name`. */
	path: string;
	refine?: Refine;
	note?: string;
}

export interface Choice {
	label: string;
	detail: string;
	/** Full path; sending it back as a `go` query jumps there. */
	path: string;
}

export type GoResult =
	| { kind: 'target'; target: Target }
	| { kind: 'choices'; title: string; choices: Choice[]; more: number }
	| { kind: 'error'; message: string };

export interface Crumb {
	label: string;
	line: number;
	endLine: number;
}

export interface Location {
	path: string;
	crumbs: Crumb[];
}

export interface Hint {
	text: string;
	/** Full replacement texts the user can Tab through. */
	completions: string[];
}

export type Query =
	/** `line` is the reader's current line, used by `#12`. */
	| { op: 'go'; text: string; line: number }
	| { op: 'complete'; text: string }
	| { op: 'pathAt'; line: number }
	| { op: 'sibling'; line: number; dir: 'next' | 'prev' | 'parent' }
	| { op: 'labels'; from: number; to: number };

export type QueryResult =
	| GoResult
	| { kind: 'hint'; hint: Hint }
	| { kind: 'location'; location: Location | null }
	| { kind: 'labels'; labels: [line: number, label: string][] };

// ------------------------------------------------------------------------ paths

type Segs = (string | number)[];

export type Step =
	| { t: 'key'; key: string }
	| { t: 'index'; index: number }
	| { t: 'pred'; key: string; value: string };

const IDENT = /^[A-Za-z_]\w*$/;

export function formatPath(segs: Segs): string {
	let out = '';
	for (const seg of segs) {
		if (typeof seg === 'number') out += `[${seg}]`;
		else if (IDENT.test(seg)) out += (out ? '.' : '') + seg;
		else out += `[${JSON.stringify(seg)}]`;
	}
	return out;
}

function stepsOf(segs: Segs): Step[] {
	return segs.map((s) => (typeof s === 'number' ? { t: 'index', index: s } : { t: 'key', key: s }));
}

/** Parse `a.b[3].c`, `["odd key"]` and `[name=="x"]`. */
export function parsePath(text: string): Step[] | { error: string } {
	const steps: Step[] = [];
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (/\s/.test(c)) {
			i++;
		} else if (c === '.') {
			i++;
			if (!/[A-Za-z_]/.test(text[i] ?? ''))
				return { error: `Expected a field name after "." (position ${i + 1}).` };
		} else if (c === '[') {
			let j = i + 1;
			let quote: string | null = null;
			for (; j < n; j++) {
				const ch = text[j];
				if (quote) {
					if (ch === '\\') j++;
					else if (ch === quote) quote = null;
				} else if (ch === '"' || ch === "'") quote = ch;
				else if (ch === ']') break;
			}
			if (j >= n) return { error: 'Missing a closing ].' };
			const inner = text.slice(i + 1, j).trim();
			const unquote = (v: string) => v.replace(/^(["'])(.*)\1$/, '$2');
			let m: RegExpExecArray | null;
			if (/^\d+$/.test(inner)) steps.push({ t: 'index', index: Number(inner) });
			else if (/^(["']).*\1$/.test(inner)) steps.push({ t: 'key', key: unquote(inner) });
			else if ((m = /^([A-Za-z_]\w*)\s*==\s*(.+)$/.exec(inner)))
				steps.push({ t: 'pred', key: m[1], value: unquote(m[2].trim()) });
			else return { error: `Can't read [${inner}]. Use [3], ["field"] or [name=="value"].` };
			i = j + 1;
		} else {
			const m = /^[A-Za-z_]\w*/.exec(text.slice(i));
			if (!m) return { error: `Unexpected "${c}" (position ${i + 1}).` };
			steps.push({ t: 'key', key: m[0] });
			i += m[0].length;
		}
	}
	return steps;
}

// ------------------------------------------------------------------- tree helpers

type Obj = Extract<Node, { k: 'obj' }>;

function describe(node: Node): string {
	switch (node.k) {
		case 'obj':
			return `an object with ${node.entries.length} field${node.entries.length === 1 ? '' : 's'}`;
		case 'list':
			return `a list of ${node.items.length} item${node.items.length === 1 ? '' : 's'}`;
		case 'array':
			return `an array of ${node.length} value${node.length === 1 ? '' : 's'}`;
		case 'bytes':
			return `${node.v.length} bytes`;
		case 'str':
			return 'a string';
		case 'enum':
			return `the enum value ${node.name}`;
		case 'scalar':
			return typeof node.v === 'boolean' ? 'a boolean' : 'a number';
	}
}

function isLeafLike(node: Node): boolean {
	return node.k === 'scalar' || node.k === 'str' || node.k === 'enum' || node.k === 'bytes';
}

function scalarText(node: Node | undefined): string | undefined {
	if (!node) return undefined;
	if (node.k === 'str') return node.v;
	if (node.k === 'enum') return node.name;
	if (node.k === 'scalar') return String(node.v);
	return undefined;
}

function entryMatches(obj: Obj, key: string, value: string): boolean {
	return scalarText(obj.entries.find(([k]) => k === key)?.[1]) === value;
}

function keySuggestion(obj: Obj, wanted: string): string {
	const keys = obj.entries.map(([k]) => k);
	const lower = wanted.toLowerCase();
	const close = keys.filter(
		(k) => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase())
	);
	const shown = (close.length ? close : keys).slice(0, 8);
	return shown.length
		? ` ${close.length ? 'Did you mean' : 'Fields are'}: ${shown.join(', ')}${keys.length > shown.length && !close.length ? ', …' : ''}.`
		: '';
}

// -------------------------------------------------------------------- resolution

interface Cursor {
	node: Node;
	/** Record of the node (or of its parent, for scalar fields), -1 if not indexed. */
	rec: number;
	segs: Segs;
	refineKey?: string;
	valueIndex?: number;
}

function walk(
	root: Node,
	outline: Outline,
	steps: Step[],
	start?: Cursor
): Cursor | { error: string } {
	let node = start?.node ?? root;
	let rec = start?.rec ?? outline.root;
	let segs: Segs = start?.segs ?? [];
	let refineKey: string | undefined;
	let valueIndex: number | undefined;
	const here = () => formatPath(segs) || 'the document root';

	for (const step of steps) {
		if (refineKey !== undefined || valueIndex !== undefined) {
			return { error: `${here()} is a single value; there is nothing below it.` };
		}
		if (step.t === 'key') {
			if (node.k !== 'obj') {
				return { error: `${here()} is ${describe(node)}, so it has no field "${step.key}".` };
			}
			const entry = node.entries.find(([k]) => k === step.key);
			if (!entry)
				return { error: `${here()} has no field "${step.key}".${keySuggestion(node, step.key)}` };
			node = entry[1];
			segs = [...segs, step.key];
			const c = rec >= 0 ? outline.child(rec, step.key) : -1;
			if (c >= 0) rec = c;
			else if (isLeafLike(node)) refineKey = step.key;
			else rec = -1;
			continue;
		}

		let index: number;
		if (step.t === 'pred') {
			if (node.k !== 'list') {
				return { error: `${here()} is ${describe(node)}; [${step.key}=="…"] only works on lists.` };
			}
			index = node.items.findIndex(
				(it) => it.k === 'obj' && entryMatches(it, step.key, step.value)
			);
			if (index < 0) return { error: `No item of ${here()} has ${step.key} = "${step.value}".` };
		} else {
			index = step.index;
		}

		if (node.k === 'list') {
			const len = node.items.length;
			if (index >= len) {
				return {
					error: len
						? `${here()} has ${len} items (0–${len - 1}); ${index} is out of range.`
						: `${here()} is empty.`
				};
			}
			node = node.items[index];
			segs = [...segs, index];
			const c = rec >= 0 ? outline.child(rec, index) : -1;
			rec = c;
		} else if (node.k === 'array' || node.k === 'bytes') {
			const len = node.k === 'array' ? node.length : node.v.length;
			if (node.k === 'bytes' && (rec < 0 || outline.kindOf(rec) !== 'array')) {
				return {
					error: `${here()} is bytes written as text in this view, so its values can't be indexed.`
				};
			}
			if (index >= len)
				return { error: `${here()} has ${len} values (0–${len - 1}); ${index} is out of range.` };
			segs = [...segs, index];
			valueIndex = index;
		} else {
			return { error: `${here()} is ${describe(node)}, so it can't be indexed.` };
		}
	}
	return { node, rec, segs, refineKey, valueIndex };
}

function toTarget(outline: Outline, cur: Cursor): GoResult {
	const path = formatPath(cur.segs);
	if (cur.rec < 0) {
		return {
			kind: 'error',
			message: outline.overflowed
				? `${path || 'That element'} is deeper than the navigation index goes for a document this large.`
				: `${path || 'That element'} hasn't been rendered yet. Try again once rendering finishes.`
		};
	}
	if (cur.valueIndex !== undefined) {
		const layout = outline.arrayLayout(cur.rec);
		if (!layout) return { kind: 'error', message: `${path} can't be located in this view.` };
		const first = outline.startOf(cur.rec) + layout.firstOffset;
		const i = cur.valueIndex;
		if (i >= layout.kept) {
			const line = first + Math.ceil(layout.kept / layout.perLine);
			return {
				kind: 'target',
				target: {
					line,
					endLine: line,
					path,
					note: `Only the first ${layout.kept} values are shown.`
				}
			};
		}
		const line = first + Math.floor(i / layout.perLine);
		return {
			kind: 'target',
			target: {
				line,
				endLine: line,
				path,
				refine: { value: { offset: i % layout.perLine, header: layout.firstOffset === 0 } }
			}
		};
	}
	const line = outline.startOf(cur.rec);
	const closed = outline.isClosed(cur.rec);
	const target: Target = { line, endLine: closed ? outline.endOf(cur.rec) : line, path };
	if (cur.refineKey !== undefined)
		target.refine = { key: cur.refineKey, root: cur.rec === outline.root };
	if (!closed) target.note = 'Still rendering; the end of this element isn’t known yet.';
	return { kind: 'target', target };
}

function recordFor(outline: Outline, segs: Segs): number {
	let rec = outline.root;
	for (const seg of segs) {
		if (rec < 0) return -1;
		rec = outline.child(rec, seg);
	}
	return rec;
}

// --------------------------------------------------------------------- traversal

interface Frame {
	node: Node;
	parent: Frame | null;
	seg: string | number | null;
}

function pathOf(frame: Frame): Segs {
	const out: Segs = [];
	for (let f: Frame | null = frame; f; f = f.parent) if (f.seg !== null) out.push(f.seg);
	return out.reverse();
}

const MAX_VISITS = 5_000_000;

/** Depth-first (document order) walk over objects and lists. Tensor values are skipped. */
function* traverse(root: Node): Generator<Frame> {
	const stack: Frame[] = [{ node: root, parent: null, seg: null }];
	let visits = 0;
	while (stack.length && visits++ < MAX_VISITS) {
		const frame = stack.pop()!;
		yield frame;
		const node = frame.node;
		if (node.k === 'obj') {
			for (let i = node.entries.length - 1; i >= 0; i--) {
				const [key, value] = node.entries[i];
				if (value.k === 'obj' || value.k === 'list')
					stack.push({ node: value, parent: frame, seg: key });
			}
		} else if (node.k === 'list') {
			for (let i = node.items.length - 1; i >= 0; i--) {
				const item = node.items[i];
				if (item.k === 'obj' || item.k === 'list')
					stack.push({ node: item, parent: frame, seg: i });
			}
		}
	}
}

/** Fields named `key` anywhere in the document, in document order. */
function findByKey(root: Node, key: string, limit: number): Frame[] {
	const hits: Frame[] = [];
	for (const frame of traverse(root)) {
		if (frame.node.k !== 'obj') continue;
		for (const [k, v] of frame.node.entries) {
			if (k === key) hits.push({ node: v, parent: frame, seg: k });
		}
		if (hits.length >= limit) break;
	}
	return hits;
}

// ------------------------------------------------------------------------- goto

function finish(outline: Outline, cur: Cursor): GoResult {
	return toTarget(outline, cur);
}

function choiceFor(segs: Segs, label: string, detail: string): Choice {
	return { label, detail, path: formatPath(segs) };
}

function searchResult(
	root: Node,
	outline: Outline,
	query: string,
	exact: { key: string; value: string } | null
): GoResult {
	type Hit = { frame: Frame; rank: number; name: string };
	const hits: Hit[] = [];
	const needle = query.toLowerCase();
	for (const frame of traverse(root)) {
		const node = frame.node;
		if (node.k !== 'obj') continue;
		if (exact) {
			const value = scalarText(node.entries.find(([k]) => k === exact.key)?.[1]);
			if (value === exact.value) hits.push({ frame, rank: 0, name: value });
		} else {
			for (const key of NAME_KEYS) {
				const entry = node.entries.find(([k]) => k === key)?.[1];
				if (entry?.k !== 'str' || !entry.v) continue;
				const hay = entry.v.toLowerCase();
				const rank =
					hay === needle ? 0 : hay.startsWith(needle) ? 1 : hay.includes(needle) ? 2 : -1;
				if (rank >= 0) hits.push({ frame, rank, name: entry.v });
				break;
			}
		}
		if (hits.length >= 5000) break;
	}
	const what = exact ? `${exact.key} = "${exact.value}"` : `"${query}"`;
	if (!hits.length) return { kind: 'error', message: `Nothing matches ${what}.` };

	hits.sort((a, b) => a.rank - b.rank); // stable: document order within a rank
	if (hits.length === 1) {
		const segs = pathOf(hits[0].frame);
		const r = walk(root, outline, stepsOf(segs));
		return 'error' in r ? { kind: 'error', message: r.error } : finish(outline, r);
	}
	return {
		kind: 'choices',
		title: `${hits.length}${hits.length >= 5000 ? '+' : ''} matches for ${what}`,
		choices: hits
			.slice(0, SEARCH_RESULT_LIMIT)
			.map((h) => choiceFor(pathOf(h.frame), h.name, formatPath(pathOf(h.frame)))),
		more: Math.max(0, hits.length - SEARCH_RESULT_LIMIT)
	};
}

/** `node[3]` where `node` isn't at the root: find where that field lives. */
function bareResolve(root: Node, outline: Outline, steps: Step[]): GoResult | null {
	if (steps[0].t !== 'key') return null;
	const rest = steps.slice(1);
	const ok: { segs: Segs; cur: Cursor }[] = [];
	let total = 0;
	for (const frame of findByKey(root, steps[0].key, 500)) {
		const segs = pathOf(frame);
		const start: Cursor = { node: frame.node, rec: recordFor(outline, segs), segs };
		const r = walk(root, outline, rest, start);
		total++;
		if (!('error' in r)) ok.push({ segs: r.segs, cur: r });
	}
	if (!ok.length) return null;
	if (ok.length === 1) return finish(outline, ok[0].cur);
	return {
		kind: 'choices',
		title: `"${steps[0].key}" is in ${ok.length}${total >= 500 ? '+' : ''} places`,
		choices: ok
			.slice(0, SEARCH_RESULT_LIMIT)
			.map((o) => choiceFor(o.segs, formatPath(o.segs), describe(o.cur.node))),
		more: Math.max(0, ok.length - SEARCH_RESULT_LIMIT)
	};
}

function relative(root: Node, outline: Outline, index: number, line: number): GoResult {
	let r = outline.deepestAt(line);
	while (r >= 0 && outline.kindOf(r) !== 'list' && outline.kindOf(r) !== 'array')
		r = outline.parentOf(r);
	if (r < 0) {
		return {
			kind: 'error',
			message: 'Put the cursor inside a list or array first, or type a full path.'
		};
	}
	const res = walk(root, outline, [...stepsOf(outline.segments(r)), { t: 'index', index }]);
	return 'error' in res ? { kind: 'error', message: res.error } : finish(outline, res);
}

export function go(root: Node, outline: Outline, text: string, line: number): GoResult {
	const t = text.trim();
	if (!t) return { kind: 'error', message: 'Type a path (graph.node[12]), a name, or #12.' };
	if (outline.size === 0) return { kind: 'error', message: 'Nothing is indexed yet.' };

	const rel = /^#\s*(\d+)$/.exec(t);
	if (rel) return relative(root, outline, Number(rel[1]), line);

	const kv = /^([A-Za-z_]\w*)\s*==\s*(.+)$/.exec(t);
	if (kv)
		return searchResult(root, outline, t, {
			key: kv[1],
			value: kv[2].trim().replace(/^(["'])(.*)\1$/, '$2')
		});

	const parsed = parsePath(t);
	let pathError: string | undefined;
	if ('error' in parsed) {
		pathError = parsed.error;
	} else if (parsed.length) {
		const res = walk(root, outline, parsed);
		if (!('error' in res)) return finish(outline, res);
		pathError = res.error;
		const bare = bareResolve(root, outline, parsed);
		if (bare) return bare;
	}

	// Not a path (or not one that exists): treat it as a name to search for.
	if (!t.includes('[')) {
		const found = searchResult(root, outline, t, null);
		if (found.kind !== 'error') return found;
	}
	return { kind: 'error', message: pathError ?? `Nothing matches "${t}".` };
}

// --------------------------------------------------------------------- completion

export function complete(root: Node, outline: Outline, text: string): Hint {
	const t = text;
	if (!t.trim()) {
		const keys = root.k === 'obj' ? root.entries.map(([k]) => k) : [];
		return {
			text: 'A path, a name, or #12. Fields: ' + (keys.slice(0, 8).join(', ') || '—'),
			completions: keys.slice(0, 12)
		};
	}
	if (t.trim().startsWith('#')) {
		return { text: 'Jump to that index in the list or array you are inside.', completions: [] };
	}
	if (/^[A-Za-z_]\w*\s*==/.test(t)) {
		return {
			text: 'Press Enter to find everything where that field has that value.',
			completions: []
		};
	}

	// Split into the path so far and the fragment being typed.
	const open = t.lastIndexOf('[');
	const closedAfter = open >= 0 && t.indexOf(']', open) >= 0;
	let prefix: string;
	let fragment = '';
	let indexing = false;
	if (open >= 0 && !closedAfter) {
		prefix = t.slice(0, open);
		indexing = true;
	} else {
		const dot = t.lastIndexOf('.');
		const tail =
			dot >= 0 && dot > open ? t.slice(dot + 1) : t.slice(open >= 0 ? t.indexOf(']', open) + 1 : 0);
		if (dot >= 0 && dot > open) {
			prefix = t.slice(0, dot);
			fragment = tail;
		} else if (open >= 0) {
			prefix = t;
		} else {
			prefix = '';
			fragment = t;
		}
	}

	const steps = parsePath(prefix);
	if ('error' in steps) return { text: steps.error, completions: [] };
	let res = walk(root, outline, steps);
	if ('error' in res && steps[0]?.t === 'key') {
		// A field that isn't at the top level: if it lives in exactly one place, hint as if the
		// path started there (that is also where Enter will take you).
		const hits = findByKey(root, steps[0].key, 3);
		if (hits.length === 1) {
			const r = walk(root, outline, steps.slice(1), {
				node: hits[0].node,
				rec: -1,
				segs: pathOf(hits[0])
			});
			if (!('error' in r)) res = r;
		} else if (hits.length > 1) {
			return {
				text: `“${steps[0].key}” appears in several places; Enter lists them.`,
				completions: []
			};
		}
	}
	if ('error' in res) {
		// Typing a name with dots/slashes: say so rather than showing a path error.
		return { text: 'Press Enter to search names for this text.', completions: [] };
	}
	const node = res.node;
	const here = formatPath(res.segs) || 'root';
	if (indexing) {
		if (node.k === 'list') {
			return {
				text: node.items.length
					? `${here}: ${node.items.length} items, indices 0–${node.items.length - 1}`
					: `${here} is empty`,
				completions: []
			};
		}
		if (node.k === 'array' || node.k === 'bytes') {
			const len = node.k === 'array' ? node.length : node.v.length;
			return { text: `${here}: ${len} values, indices 0–${len - 1}`, completions: [] };
		}
		return { text: `${here} is ${describe(node)}`, completions: [] };
	}
	if (node.k === 'obj') {
		const lower = fragment.toLowerCase();
		const keys = node.entries.map(([k]) => k).filter((k) => k.toLowerCase().startsWith(lower));
		const base = prefix ? prefix + '.' : '';
		return {
			text: `${here}: ${describe(node)}${keys.length ? '' : ' (no field starts with that)'}`,
			completions: keys.slice(0, 12).map((k) => base + k)
		};
	}
	return { text: `${here}: ${describe(node)}`, completions: [] };
}

// ------------------------------------------------------------- location & siblings

export function locationAt(outline: Outline, line: number): Location | null {
	const id = outline.deepestAt(line);
	if (id < 0) return null;
	const chain: number[] = [];
	for (let r = id; r >= 0; r = outline.parentOf(r)) chain.unshift(r);

	const crumbs: Crumb[] = [];
	const segs: Segs = [];
	let previousWasList = false;
	for (const r of chain) {
		const seg = outline.segOf(r);
		if (seg === null) continue;
		segs.push(seg);
		const span = { line: outline.startOf(r), endLine: outline.endOf(r) };
		if (typeof seg === 'number') {
			const last = crumbs[crumbs.length - 1];
			if (last && previousWasList) {
				last.label += `[${seg}]`;
				last.line = span.line;
				last.endLine = span.endLine;
			} else {
				crumbs.push({ label: `[${seg}]`, ...span });
			}
		} else {
			crumbs.push({ label: seg, ...span });
		}
		previousWasList = outline.kindOf(r) === 'list';
	}

	// Inside a tensor: say which values this row holds.
	const layout = outline.arrayLayout(id);
	let path = formatPath(segs);
	if (layout && layout.firstOffset === 1) {
		const row = line - outline.startOf(id) - 1;
		if (row >= 0 && row * layout.perLine < layout.kept) {
			const from = row * layout.perLine;
			const to = Math.min(layout.kept, from + layout.perLine) - 1;
			crumbs.push({ label: `[${from}–${to}]`, line, endLine: line });
			path += `[${from}]`;
		}
	}
	return { path, crumbs };
}

export function sibling(outline: Outline, line: number, dir: 'next' | 'prev' | 'parent'): GoResult {
	const current = outline.deepestAt(line);
	if (current < 0) return { kind: 'error', message: 'Nothing to move from here.' };
	const toTargetRec = (r: number): GoResult => ({
		kind: 'target',
		target: {
			line: outline.startOf(r),
			endLine: outline.isClosed(r) ? outline.endOf(r) : outline.startOf(r),
			path: formatPath(outline.segments(r))
		}
	});

	if (dir === 'parent') {
		const p = outline.parentOf(current);
		// From a list element, "up" means the element's container's owner, not the list header.
		if (p < 0 || p === outline.root) return { kind: 'error', message: 'Already at the top level.' };
		return toTargetRec(p);
	}
	let e = current;
	while (e >= 0 && !(outline.parentOf(e) >= 0 && outline.kindOf(outline.parentOf(e)) === 'list'))
		e = outline.parentOf(e);
	if (e < 0) return { kind: 'error', message: 'Not inside a list element.' };
	const sib = dir === 'next' ? outline.nextSibling(e) : outline.prevSibling(e);
	if (sib < 0) {
		const list = formatPath(outline.segments(outline.parentOf(e)));
		return {
			kind: 'error',
			message: `That is the ${dir === 'next' ? 'last' : 'first'} item of ${list}.`
		};
	}
	return toTargetRec(sib);
}

// ---------------------------------------------------------------------- dispatch

export function answerQuery(root: Node, outline: Outline, q: Query): QueryResult {
	switch (q.op) {
		case 'go':
			return go(root, outline, q.text, q.line);
		case 'complete':
			return { kind: 'hint', hint: complete(root, outline, q.text) };
		case 'pathAt':
			return { kind: 'location', location: locationAt(outline, q.line) };
		case 'sibling':
			return sibling(outline, q.line, q.dir);
		case 'labels':
			return { kind: 'labels', labels: outline.labels(q.from, q.to) };
	}
}
