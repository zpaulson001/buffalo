<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Compartment,
		EditorSelection,
		EditorState,
		StateEffect,
		type Extension,
		type Text
	} from '@codemirror/state';
	import {
		EditorView,
		GutterMarker,
		drawSelection,
		gutter,
		keymap,
		lineNumbers
	} from '@codemirror/view';
	import { bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
	import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
	import { darkTheme, lightTheme } from './editorTheme';
	import { FoldIndex } from './foldIndex';
	import { languageExtension } from './languages';
	import type { OutputSink, RevealTarget } from './session.svelte';

	let {
		dark,
		labels,
		showLabels,
		onready,
		onposition,
		onviewport
	}: {
		dark: boolean;
		/** `[n]` labels for visible lines, keyed by line number. */
		labels: Map<number, string>;
		showLabels: boolean;
		onready: (sink: OutputSink) => void | (() => void);
		/** The reader's line changed (clicked, or scrolled to). */
		onposition?: (line: number) => void;
		/** The visible line range changed. */
		onviewport?: (from: number, to: number) => void;
	} = $props();

	let host: HTMLDivElement;
	let view: EditorView | undefined;

	const foldIndex = new FoldIndex();
	// One compartment per swappable part, shared by every state we create.
	const themeSlot = new Compartment();
	const indexSlot = new Compartment();

	// ------------------------------------------------------------- index gutter

	class LabelMarker extends GutterMarker {
		label: string;
		constructor(label: string) {
			super();
			this.label = label;
		}
		eq(other: LabelMarker) {
			return other.label === this.label;
		}
		toDOM() {
			return document.createTextNode(this.label);
		}
	}

	const labelsChanged = StateEffect.define<null>();
	let currentLabels = new Map<number, string>();

	function indexGutter(): Extension {
		return gutter({
			class: 'cm-index-gutter',
			lineMarker(v, line) {
				const label = currentLabels.get(v.state.doc.lineAt(line.from).number);
				return label ? new LabelMarker(label) : null;
			},
			lineMarkerChange: (update) =>
				update.transactions.some((tr) => tr.effects.some((e) => e.is(labelsChanged))),
			initialSpacer: () => new LabelMarker('[000000]')
		});
	}

	$effect(() => {
		currentLabels = labels;
		view?.dispatch({ effects: labelsChanged.of(null) });
	});

	$effect(() => {
		// Read the prop before touching `view`: `view?.f(x)` skips evaluating `x` while view is unset,
		// which would leave this effect with no dependencies.
		const extension = showLabels ? indexGutter() : [];
		view?.dispatch({ effects: indexSlot.reconfigure(extension) });
	});

	// ------------------------------------------------------------------- state

	/** After a click or a jump, scrolling doesn't move the reader's position for a moment. */
	let positionLockedUntil = 0;
	let reportScheduled = false;

	function scheduleReport() {
		if (reportScheduled) return;
		reportScheduled = true;
		requestAnimationFrame(() => {
			reportScheduled = false;
			if (!view) return;
			const doc = view.state.doc;
			const scroller = view.scrollDOM;
			const top = doc.lineAt(view.lineBlockAtHeight(scroller.scrollTop + 4).from).number;
			const bottom = doc.lineAt(
				view.lineBlockAtHeight(scroller.scrollTop + scroller.clientHeight).from
			).number;
			onviewport?.(Math.max(1, top - 4), bottom + 4);
			if (Date.now() >= positionLockedUntil) onposition?.(top);
		});
	}

	function makeState(language: string): EditorState {
		return EditorState.create({
			doc: '',
			extensions: [
				EditorState.readOnly.of(true),
				EditorView.editable.of(false),
				// Paint the selection ourselves: a non-editable editor shows no native one, and
				// jumps (go to, siblings) highlight their target by selecting it.
				drawSelection(),
				lineNumbers(),
				indexSlot.of(showLabels ? indexGutter() : []),
				foldGutter(),
				bracketMatching(),
				search({ top: true }),
				highlightSelectionMatches(),
				keymap.of([...searchKeymap, ...foldKeymap]),
				languageExtension(language, foldIndex),
				themeSlot.of(dark ? darkTheme : lightTheme),
				EditorView.updateListener.of((update) => {
					if (
						update.selectionSet &&
						update.transactions.some((tr) => tr.isUserEvent('select.pointer'))
					) {
						positionLockedUntil = Date.now() + 1500;
						const head = update.state.selection.main.head;
						onposition?.(update.state.doc.lineAt(head).number);
					}
					if (update.viewportChanged || update.geometryChanged) scheduleReport();
				})
			]
		});
	}

	// Switching theme restyles the current document in place.
	$effect(() => {
		const extension = dark ? darkTheme : lightTheme;
		view?.dispatch({ effects: themeSlot.reconfigure(extension) });
	});

	// ----------------------------------------------------------- streaming text

	// Chunks arrive faster than frames; coalesce them into one dispatch per flush.
	let pending: string[] = [];
	let waiters: (() => void)[] = [];
	let lineWaiters: { line: number; resolve: (ok: boolean) => void }[] = [];
	let scheduled = false;

	function flush() {
		scheduled = false;
		if (view && pending.length) {
			const text = pending.join('');
			// Index before dispatch so fold lookups never see lines the index lacks.
			foldIndex.push(text);
			view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
		}
		pending = [];
		const done = waiters;
		waiters = [];
		for (const w of done) w();
		if (view && lineWaiters.length) {
			const lines = view.state.doc.lines;
			lineWaiters = lineWaiters.filter((w) => {
				if (lines < w.line) return true;
				w.resolve(true);
				return false;
			});
		}
	}

	function schedule() {
		if (scheduled) return;
		scheduled = true;
		// rAF is paused in background tabs; the timeout keeps the pipeline moving.
		requestAnimationFrame(() => scheduled && flush());
		setTimeout(() => scheduled && flush(), 250);
	}

	// -------------------------------------------------------------------- reveal

	const indentOf = (text: string) => text.length - text.trimStart().length;
	const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	/** The line of `key` among the direct fields of the object that starts at `start`. */
	function findKeyLine(doc: Text, start: number, end: number, key: string, root: boolean) {
		const first = doc.line(start).text;
		// A prototext root has no brace: its first line is already its first field.
		const opensBlock = /[{[]\s*$/.test(first) && (!root || first.trim() === '{');
		const scanFrom = opensBlock ? start + 1 : start;
		if (scanFrom > end) return null;
		const childIndent = indentOf(doc.line(scanFrom).text);
		const pattern = new RegExp(`^\\s*"?${escapeRegExp(key)}"?\\s*(?::|\\{|\\[)`);
		for (let n = scanFrom; n <= end && n <= scanFrom + 5000; n++) {
			const line = doc.line(n);
			if (indentOf(line.text) === childIndent && pattern.test(line.text)) return line;
		}
		return null;
	}

	/** The `offset`-th value on a tensor line. `header`: values follow `[` on the array's first line. */
	function valueRange(
		line: { from: number; text: string },
		value: { offset: number; header: boolean }
	) {
		const text = line.text;
		let a = value.header ? text.indexOf('[') + 1 : indentOf(text);
		const b = value.header ? text.lastIndexOf(']') : text.length;
		if (a <= 0 && value.header) return null;
		for (let k = 0; a <= b; k++) {
			const next = text.indexOf(', ', a);
			let stop = next === -1 || next >= b ? b : next;
			if (k === value.offset) {
				while (stop > a && /[\s,]/.test(text[stop - 1])) stop--; // trailing comma of a row
				return { from: line.from + a, to: line.from + stop };
			}
			if (next === -1 || next >= b) break;
			a = next + 2;
		}
		return null;
	}

	async function reveal(target: RevealTarget): Promise<boolean> {
		if (!view) return false;
		if (view.state.doc.lines < target.endLine) {
			const arrived = await new Promise<boolean>((resolve) => {
				lineWaiters.push({ line: target.endLine, resolve });
				setTimeout(() => resolve(false), 30_000);
			});
			if (!arrived || !view) return false;
		}
		const doc = view.state.doc;
		const startLine = doc.line(Math.min(target.line, doc.lines));
		const endLine = doc.line(Math.min(Math.max(target.endLine, target.line), doc.lines));
		let from = startLine.from;
		let to = endLine.to;
		const refine = target.refine;
		if (refine?.key) {
			const found = findKeyLine(doc, startLine.number, endLine.number, refine.key, !!refine.root);
			if (found) [from, to] = [found.from, found.to];
		} else if (refine?.value) {
			const range = valueRange(startLine, refine.value);
			if (range) [from, to] = [range.from, range.to];
		}
		positionLockedUntil = Date.now() + 1500;
		view.dispatch({
			selection: EditorSelection.range(from, to),
			effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 12 }),
			userEvent: 'select'
		});
		view.focus();
		return true;
	}

	const sink: OutputSink = {
		reset(language) {
			pending = [];
			// Release anything waiting on the old document.
			const old = waiters;
			waiters = [];
			for (const w of old) w();
			for (const w of lineWaiters) w.resolve(false);
			lineWaiters = [];
			foldIndex.reset();
			view?.setState(makeState(language));
		},
		append(text) {
			pending.push(text);
			schedule();
			return new Promise((resolve) => waiters.push(resolve));
		},
		reveal
	};

	onMount(() => {
		view = new EditorView({ state: makeState('json'), parent: host });
		const onScroll = () => scheduleReport();
		view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
		const cleanup = onready(sink);
		return () => {
			view?.scrollDOM.removeEventListener('scroll', onScroll);
			cleanup?.();
			view?.destroy();
		};
	});
</script>

<div bind:this={host} class="h-full min-h-0 overflow-hidden"></div>
