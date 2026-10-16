<script module lang="ts">
	export interface SchemaItem {
		/** Shown as the main label, e.g. "onnx.proto". */
		name: string;
		/** Shown under it, e.g. "ONNX (protobuf)". */
		hint: string;
		language: 'proto' | 'fbs';
		text: string;
	}
</script>

<script lang="ts">
	let {
		items,
		active,
		onselect,
		buttonClass
	}: {
		items: SchemaItem[];
		/** Title of the schema currently on screen, if any. */
		active: string | null;
		onselect: (item: SchemaItem) => void;
		buttonClass: string;
	} = $props();

	let open = $state(false);
</script>

<svelte:window
	onclick={() => (open = false)}
	onkeydown={(e) => e.key === 'Escape' && (open = false)}
/>

<div class="relative">
	<button
		class={buttonClass}
		aria-haspopup="menu"
		aria-expanded={open}
		onclick={(e) => {
			e.stopPropagation();
			open = !open;
		}}
	>
		Schemas ▾
	</button>
	{#if open}
		<ul
			role="menu"
			class="absolute right-0 z-40 mt-1 w-72 overflow-hidden rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
		>
			{#each items as item (item.hint + item.name)}
				<li role="none">
					<button
						role="menuitem"
						class="block w-full px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800 {active ===
						item.name
							? 'bg-gray-100 dark:bg-gray-800'
							: ''}"
						onclick={() => {
							open = false;
							onselect(item);
						}}
					>
						<span class="block font-medium">{item.name}</span>
						<span class="block text-xs text-gray-500 dark:text-gray-400">{item.hint}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
