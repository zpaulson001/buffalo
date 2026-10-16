<script lang="ts">
	import { onMount } from 'svelte';
	import type { Choice, GoResult, Hint } from '../core/navigate';

	let {
		hex,
		go,
		complete,
		onclose
	}: {
		/** Hex view: the box takes byte offsets instead of paths. */
		hex: boolean;
		go: (text: string) => Promise<GoResult>;
		complete: (text: string) => Promise<Hint | null>;
		onclose: () => void;
	} = $props();

	let input: HTMLInputElement;
	let text = $state('');
	let hint = $state<Hint | null>(null);
	let choices = $state<{ title: string; items: Choice[]; more: number } | null>(null);
	let error = $state<string | null>(null);
	let selected = $state(-1);
	let busy = $state(false);

	let typed = 0; // ignores hints that arrive after newer input
	let timer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		input.focus();
		void refreshHint();
	});

	async function refreshHint() {
		const mine = ++typed;
		const h = await complete(text);
		if (mine === typed) hint = h;
	}

	function oninput() {
		error = null;
		choices = null;
		selected = -1;
		clearTimeout(timer);
		timer = setTimeout(() => void refreshHint(), 100);
	}

	const completions = $derived(choices ? [] : (hint?.completions ?? []));

	async function submit(value: string) {
		busy = true;
		const result = await go(value);
		busy = false;
		if (result.kind === 'target') return onclose();
		if (result.kind === 'choices') {
			choices = { title: result.title, items: result.choices, more: result.more };
			error = null;
			selected = 0;
		} else if (result.kind === 'error') {
			error = result.message;
			choices = null;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		const list = choices ? choices.items.length : completions.length;
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		} else if (e.key === 'ArrowDown' && list) {
			e.preventDefault();
			selected = (selected + 1) % list;
		} else if (e.key === 'ArrowUp' && list) {
			e.preventDefault();
			selected = (selected - 1 + list) % list;
		} else if (e.key === 'Tab' && completions.length) {
			e.preventDefault();
			text = completions[Math.max(0, selected)];
			selected = -1;
			void refreshHint();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (choices && selected >= 0) void submit(choices.items[selected].path);
			else if (!choices && selected >= 0 && completions[selected]) {
				text = completions[selected];
				void submit(text);
			} else void submit(text);
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-40" onclick={onclose}>
	<div
		role="dialog"
		aria-label="Go to"
		tabindex="-1"
		class="absolute top-16 left-1/2 w-[min(40rem,92vw)] -translate-x-1/2 rounded-lg border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-900"
		onclick={(e) => e.stopPropagation()}
	>
		<input
			bind:this={input}
			bind:value={text}
			{oninput}
			{onkeydown}
			disabled={busy}
			spellcheck="false"
			autocomplete="off"
			placeholder={hex
				? 'Byte offset, e.g. 0x1f40 or 8000'
				: 'graph.node[1204]   ·   node[1204]   ·   #12   ·   conv1.weight'}
			class="w-full rounded border border-gray-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800"
		/>

		{#if error}
			<p class="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>
		{:else if choices}
			<p class="mt-2 text-xs text-gray-600 dark:text-gray-400">{choices.title}</p>
			<ul class="mt-1 max-h-72 overflow-auto text-sm" role="listbox">
				{#each choices.items as item, i (item.path)}
					<li role="option" aria-selected={i === selected}>
						<button
							class="block w-full rounded px-2 py-1 text-left hover:bg-gray-100 dark:hover:bg-gray-800 {i ===
							selected
								? 'bg-gray-100 dark:bg-gray-800'
								: ''}"
							onclick={() => void submit(item.path)}
						>
							<span class="font-medium">{item.label}</span>
							<span class="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400"
								>{item.detail}</span
							>
						</button>
					</li>
				{/each}
			</ul>
			{#if choices.more}
				<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
					…and {choices.more} more. Be more specific to narrow it down.
				</p>
			{/if}
		{:else}
			{#if hint?.text}
				<p class="mt-2 text-xs text-gray-600 dark:text-gray-400">{hint.text}</p>
			{/if}
			{#if completions.length}
				<ul class="mt-1 max-h-56 overflow-auto font-mono text-sm" role="listbox">
					{#each completions as c, i (c)}
						<li role="option" aria-selected={i === selected}>
							<button
								class="block w-full rounded px-2 py-0.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800 {i ===
								selected
									? 'bg-gray-100 dark:bg-gray-800'
									: ''}"
								onclick={() => {
									text = c;
									void refreshHint();
									input.focus();
								}}
							>
								{c}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
		<p class="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
			Enter to jump · Tab to complete · Esc to close
		</p>
	</div>
</div>
