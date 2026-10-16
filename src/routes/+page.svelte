<script lang="ts">
	import { onMount } from 'svelte';
	import { baseSchemas, outputFormats, supportedExtensions } from '../lib/core/formats';
	import { formatBytes } from '../lib/ui/format';
	import OutputEditor from '../lib/ui/OutputEditor.svelte';
	import SchemaMenu, { type SchemaItem } from '../lib/ui/SchemaMenu.svelte';
	import SizeGuardDialog from '../lib/ui/SizeGuardDialog.svelte';
	import { session } from '../lib/ui/session.svelte';
	import { theme, type ThemeMode } from '../lib/ui/theme.svelte';

	let dragging = $state(false);
	let picker: HTMLInputElement;

	onMount(() => theme.init());

	const supported = supportedExtensions().join(' / ');
	const phaseLabel = {
		read: 'Reading file',
		decode: 'Decoding',
		estimate: 'Estimating size',
		serialize: 'Rendering'
	} as const;

	const buttonClass =
		'rounded border border-gray-300 bg-white px-3 py-1 text-sm hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700';

	/** Bundled schemas first, then whatever the user supplied. */
	const schemaItems: SchemaItem[] = $derived([
		...baseSchemas().map((s) => ({
			name: s.fileName,
			hint: s.source,
			language: s.language,
			text: s.text
		})),
		...session.schema.map((s) => ({
			name: s.name,
			hint: 'Your schema',
			language: 'fbs' as const,
			text: s.text
		}))
	]);

	const viewing = $derived(session.schemaView);
	const busy = $derived(
		!viewing && (session.status === 'loading' || session.status === 'rendering')
	);
	const percent = $derived(
		session.progress.total > 0
			? Math.min(100, (session.progress.done / session.progress.total) * 100)
			: null
	);

	function takeFiles(files: FileList | null | undefined) {
		if (files?.length) void session.openFiles([...files]);
	}

	function ondrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		takeFiles(e.dataTransfer?.files);
	}

	function ondragover(e: DragEvent) {
		e.preventDefault();
		dragging = true;
	}
</script>

<svelte:head>
	<title>🦬 Buffalo – binary model viewer</title>
</svelte:head>

<div
	class="flex h-screen flex-col bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100"
	role="application"
	{ondrop}
	{ondragover}
	ondragleave={() => (dragging = false)}
>
	<header
		class="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-800 dark:bg-gray-900"
	>
		<h1 class="font-semibold">🦬 Buffalo</h1>
		{#if session.fileName}
			<span class="truncate text-sm text-gray-600 dark:text-gray-400">
				{session.fileName} · {formatBytes(session.fileSize)}
			</span>
		{/if}
		{#if session.schema.length}
			<span
				class="flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-0.5 text-xs text-blue-800 dark:bg-blue-950 dark:text-blue-200"
				title="FlatBuffers schema used to read the file"
			>
				Schema: {session.schema.map((s) => s.name).join(', ')}
				<button
					class="ml-1 rounded px-1 hover:bg-blue-100 dark:hover:bg-blue-900"
					aria-label="Clear schema"
					onclick={() => session.clearSchema()}
				>
					✕
				</button>
			</span>
		{/if}
		<div class="ml-auto flex flex-wrap items-center gap-2">
			<div
				class="flex overflow-hidden rounded border border-gray-300 text-sm dark:border-gray-700"
				role="group"
				aria-label="Output format"
			>
				{#each outputFormats as f (f.id)}
					<button
						class="px-3 py-1 {!viewing && session.outputFormat === f.id
							? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
							: 'bg-white hover:bg-gray-100 dark:bg-gray-800 dark:hover:bg-gray-700'}"
						onclick={() => session.setFormat(f.id)}
					>
						{f.label}
					</button>
				{/each}
			</div>
			<SchemaMenu
				items={schemaItems}
				active={viewing?.title ?? null}
				{buttonClass}
				onselect={(item) => session.viewSchema(item.name, item.language, item.text)}
			/>
			<button class={buttonClass} onclick={() => picker.click()}>Open file…</button>
			<input
				bind:this={picker}
				type="file"
				multiple
				class="hidden"
				onchange={(e) => takeFiles(e.currentTarget.files)}
			/>
			<select
				aria-label="Theme"
				class="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
				value={theme.mode}
				onchange={(e) => theme.set(e.currentTarget.value as ThemeMode)}
			>
				<option value="light">Light</option>
				<option value="dark">Dark</option>
				<option value="system">System</option>
			</select>
		</div>
	</header>

	{#if viewing}
		<div
			class="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-1.5 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300"
		>
			<span>Viewing schema <strong>{viewing.title}</strong></span>
			<button
				class="ml-auto rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
				onclick={() => session.closeSchemaView()}
			>
				{session.fileName ? 'Back to output' : 'Close'}
			</button>
		</div>
	{/if}

	{#if busy}
		<div
			class="border-b border-gray-200 bg-white px-4 py-1.5 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400"
		>
			<div class="flex justify-between">
				<span>{session.phase ? phaseLabel[session.phase] : 'Working'}…</span>
				{#if percent !== null}<span>{percent.toFixed(0)}%</span>{/if}
			</div>
			<div class="mt-1 h-1 overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
				<div
					class="h-full bg-blue-600 {percent === null ? 'w-1/3 animate-pulse' : ''}"
					style:width={percent === null ? undefined : `${percent}%`}
				></div>
			</div>
		</div>
	{/if}

	{#if session.error}
		<div
			class="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
			role="alert"
		>
			{session.error}
		</div>
	{/if}

	{#if !viewing && session.status === 'done' && session.truncated}
		<div
			class="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
		>
			Output is truncated. Look for “... N more” markers.
		</div>
	{/if}

	<main class="relative min-h-0 flex-1">
		<OutputEditor dark={theme.dark} onready={(sink) => session.attach(sink)} />

		{#if !viewing && session.status === 'idle' && !session.fileName}
			<button
				class="absolute inset-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-gray-50/90 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:bg-gray-950/90 dark:text-gray-400 dark:hover:border-gray-500"
				onclick={() => picker.click()}
			>
				{#if session.schema.length}
					<span class="text-lg font-medium">Schema loaded. Drop the file to read with it.</span>
				{:else}
					<span class="text-lg font-medium">Drop a {supported} file here</span>
				{/if}
				<span class="mt-1 text-sm">
					Or click to choose. For other FlatBuffers files, drop a .fbs schema together with the
					file. Nothing leaves your browser.
				</span>
			</button>
		{/if}

		{#if dragging}
			<div
				class="pointer-events-none absolute inset-4 flex items-center justify-center rounded-xl border-2 border-dashed border-blue-500 bg-blue-50/80 text-lg font-medium text-blue-700 dark:bg-blue-950/80 dark:text-blue-200"
			>
				Drop to open
			</div>
		{/if}
	</main>
</div>

{#if session.confirm}
	<SizeGuardDialog
		info={session.confirm}
		onfull={() => session.chooseFull()}
		ontruncate={(n) => session.chooseTruncated(n)}
		oncancel={() => session.cancelConfirm()}
	/>
{/if}
