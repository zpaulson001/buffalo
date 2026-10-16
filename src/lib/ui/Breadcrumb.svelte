<script lang="ts">
	import type { Crumb, Location } from '../core/navigate';

	let {
		location,
		notice,
		onjump,
		onstep
	}: {
		location: Location;
		/** Short message about the last move (e.g. "That is the last item"). */
		notice: string | null;
		onjump: (crumb: Crumb) => void;
		onstep: (dir: 'next' | 'prev' | 'parent') => void;
	} = $props();

	let copied = $state(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(location.path);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard unavailable (insecure context or denied): nothing to do.
		}
	}

	const stepButton =
		'rounded px-1.5 py-0.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800';
</script>

<div
	class="flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-1 text-xs dark:border-gray-800 dark:bg-gray-900"
	aria-label="Location"
>
	<div class="flex shrink-0 items-center" role="group" aria-label="Move">
		<button class={stepButton} title="Previous item (Alt+↑)" onclick={() => onstep('prev')}
			>‹</button
		>
		<button class={stepButton} title="Next item (Alt+↓)" onclick={() => onstep('next')}>›</button>
		<button class={stepButton} title="Parent (Alt+Shift+↑)" onclick={() => onstep('parent')}
			>↑</button
		>
	</div>
	<nav class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto font-mono whitespace-nowrap">
		{#each location.crumbs as crumb, i (i)}
			{#if i > 0}<span class="text-gray-400">›</span>{/if}
			<button
				class="rounded px-1 hover:bg-gray-100 dark:hover:bg-gray-800"
				title="Go to line {crumb.line}"
				onclick={() => onjump(crumb)}
			>
				{crumb.label}
			</button>
		{:else}
			<span class="text-gray-400">(top level)</span>
		{/each}
	</nav>
	{#if notice}
		<span class="shrink-0 text-amber-700 dark:text-amber-300" role="status">{notice}</span>
	{/if}
	<button
		class="shrink-0 rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
		title="Copy this path"
		onclick={copy}
	>
		{copied ? 'Copied' : 'Copy path'}
	</button>
</div>
