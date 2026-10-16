<script lang="ts">
	import { formatBytes } from './format';
	import type { ConfirmInfo } from './session.svelte';

	let {
		info,
		onfull,
		ontruncate,
		oncancel
	}: {
		info: ConfirmInfo;
		onfull: () => void;
		ontruncate: (n: number) => void;
		oncancel: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let n = $state(info.truncateTo);
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
	<div
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="guard-title"
		class="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900 dark:text-gray-100"
	>
		<h2 id="guard-title" class="text-lg font-semibold">This output is very large</h2>
		<p class="mt-2 text-sm text-gray-700 dark:text-gray-300">
			Showing the full output is estimated at about
			<strong>{formatBytes(info.fullChars)}</strong> of text (limit {formatBytes(info.limit)}). That
			can make the tab slow or crash it.
		</p>
		<div class="mt-4 flex items-center gap-2 text-sm">
			<label for="trunc-n">Keep the first</label>
			<input
				id="trunc-n"
				type="number"
				min="0"
				bind:value={n}
				class="w-24 rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-700 dark:bg-gray-800"
			/>
			<span>{info.truncateLabel} (about {formatBytes(info.truncatedChars)})</span>
		</div>
		<div class="mt-6 flex flex-wrap justify-end gap-2">
			<button
				class="rounded px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
				onclick={oncancel}
			>
				Cancel
			</button>
			<button
				class="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
				onclick={onfull}
			>
				Show everything anyway
			</button>
			<button
				class="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
				onclick={() => ontruncate(Math.max(0, Math.floor(n) || 0))}
			>
				Truncate
			</button>
		</div>
	</div>
</div>
