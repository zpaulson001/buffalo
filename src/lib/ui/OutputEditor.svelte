<script lang="ts">
	import { onMount } from 'svelte';
	import { Compartment, EditorState } from '@codemirror/state';
	import { EditorView, keymap, lineNumbers } from '@codemirror/view';
	import { bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
	import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
	import { darkTheme, lightTheme } from './editorTheme';
	import { FoldIndex } from './foldIndex';
	import { languageExtension } from './languages';
	import type { OutputSink } from './session.svelte';

	let { dark, onready }: { dark: boolean; onready: (sink: OutputSink) => void | (() => void) } =
		$props();

	let host: HTMLDivElement;
	let view: EditorView | undefined;

	const foldIndex = new FoldIndex();
	// One compartment shared by every state we create, so the theme can be swapped live.
	const themeSlot = new Compartment();

	function makeState(language: string): EditorState {
		return EditorState.create({
			doc: '',
			extensions: [
				EditorState.readOnly.of(true),
				EditorView.editable.of(false),
				lineNumbers(),
				foldGutter(),
				bracketMatching(),
				search({ top: true }),
				highlightSelectionMatches(),
				keymap.of([...searchKeymap, ...foldKeymap]),
				languageExtension(language, foldIndex),
				themeSlot.of(dark ? darkTheme : lightTheme)
			]
		});
	}

	// Switching theme restyles the current document in place.
	$effect(() => {
		const extension = dark ? darkTheme : lightTheme;
		view?.dispatch({ effects: themeSlot.reconfigure(extension) });
	});

	// Chunks arrive faster than frames; coalesce them into one dispatch per flush.
	let pending: string[] = [];
	let waiters: (() => void)[] = [];
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
	}

	function schedule() {
		if (scheduled) return;
		scheduled = true;
		// rAF is paused in background tabs; the timeout keeps the pipeline moving.
		requestAnimationFrame(() => scheduled && flush());
		setTimeout(() => scheduled && flush(), 250);
	}

	const sink: OutputSink = {
		reset(language) {
			pending = [];
			// Release anything waiting on the old document.
			const old = waiters;
			waiters = [];
			for (const w of old) w();
			foldIndex.reset();
			view?.setState(makeState(language));
		},
		append(text) {
			pending.push(text);
			schedule();
			return new Promise((resolve) => waiters.push(resolve));
		}
	};

	onMount(() => {
		view = new EditorView({ state: makeState('json'), parent: host });
		const cleanup = onready(sink);
		return () => {
			cleanup?.();
			view?.destroy();
		};
	});
</script>

<div bind:this={host} class="h-full min-h-0 overflow-hidden"></div>
