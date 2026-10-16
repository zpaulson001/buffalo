/* eslint-disable svelte/prefer-svelte-reactivity --
   The Maps here never need per-key reactivity: `labels` is replaced wholesale
   ($state.raw) and `pending` is plain bookkeeping for in-flight queries. */
import { detectInputFormat, outputFormats } from '../core/formats';
import type { SchemaSource } from '../core/input/flatbuffers';
import { TRUNCATE_TO } from '../core/config';
import type {
	GoResult,
	Hint,
	Location,
	Query,
	QueryResult,
	Refine,
	Target
} from '../core/navigate';
import { prefs } from './prefs.svelte';
import { WorkerClient } from '../worker/client';
import type { FromWorker, Phase, ToWorker } from '../worker/protocol';

/** Where rendered text goes. Implemented by the CodeMirror component. */
export interface OutputSink {
	/** Clear the document and switch language mode. */
	reset(language: string): void;
	/** Append text; resolves once it has been applied to the editor. */
	append(text: string): Promise<void>;
	/**
	 * Scroll to and select lines `line`..`endLine` (or the part `refine` names),
	 * waiting for them to be streamed in if needed. Resolves false if they never arrive.
	 */
	reveal(target: RevealTarget): Promise<boolean>;
}

export interface RevealTarget {
	line: number;
	endLine: number;
	refine?: Refine;
}

export type Status = 'idle' | 'loading' | 'rendering' | 'confirm' | 'done' | 'error';

export interface ConfirmInfo {
	fullChars: number;
	truncatedChars: number;
	limit: number;
	truncateTo: number;
	truncateLabel: string;
}

/** What Session needs from the worker connection; WorkerClient in the app, a fake in tests. */
export interface WorkerLike {
	send(msg: ToWorker): void;
	terminate(): void;
}

export type WorkerFactory = (onMessage: (msg: FromWorker) => void) => WorkerLike;

/** UI-facing state and actions. Plain class so tests can drive it with a fake worker. */
export class Session {
	status = $state<Status>('idle');
	phase = $state<Phase | null>(null);
	progress = $state({ done: 0, total: 0 });
	fileName = $state('');
	fileSize = $state(0);
	outputFormat = $state(outputFormats[0].id);
	truncated = $state(false);
	confirm = $state<ConfirmInfo | null>(null);
	error = $state<string | null>(null);

	/** Set while a schema's source (not the output) is shown in the editor. */
	schemaView = $state<{ title: string; language: string } | null>(null);

	/** User-supplied FlatBuffers schema sources. `.raw` so it can be posted to the worker as-is. */
	schema = $state.raw<SchemaSource[]>([]);

	/** Breadcrumb for the line the reader is at (null when unknown or not navigable). */
	location = $state.raw<Location | null>(null);

	/** `[n]` labels for the visible lines, line number -> label. */
	labels = $state.raw<Map<number, string>>(new Map());

	/** A short message about the last navigation attempt (e.g. "last item"), cleared after a moment. */
	notice = $state<string | null>(null);

	/** Line the reader is at: set by scrolling, clicking and jumping. */
	position = 1;

	private viewport = { from: 1, to: 60 };
	private timers: {
		location?: ReturnType<typeof setTimeout>;
		labels?: ReturnType<typeof setTimeout>;
		notice?: ReturnType<typeof setTimeout>;
	} = {};
	private nextQueryId = 1;
	private pending = new Map<number, (result: QueryResult | null) => void>();

	private currentFile: File | null = null;
	/** Reactive: the template shows navigation controls once a file is decoded. */
	private hasDoc = $state(false);
	private client: WorkerLike | null = null;
	private sink: OutputSink | null = null;
	private runId = 0;

	constructor(private createClient: WorkerFactory = (onMessage) => new WorkerClient(onMessage)) {}

	attach(sink: OutputSink): () => void {
		this.sink = sink;
		this.client ??= this.createClient((msg) => this.onMessage(msg));
		return () => {
			this.client?.terminate();
			this.client = null;
			this.sink = null;
			for (const resolve of this.pending.values()) resolve(null);
			this.pending.clear();
		};
	}

	/**
	 * Handle dropped/picked files. `.fbs` files set the FlatBuffers schema used
	 * for reading; anything else is the file to view. A schema alone re-reads the
	 * file that is already open.
	 */
	async openFiles(files: File[]): Promise<void> {
		const fbs = files.filter((f) => f.name.toLowerCase().endsWith('.fbs'));
		const data = files.find((f) => !fbs.includes(f));
		if (fbs.length) {
			this.schema = await Promise.all(
				fbs.map(async (f) => ({ name: f.name, text: await f.text() }))
			);
		}
		const target = data ?? (fbs.length ? this.currentFile : null);
		if (target) this.open(target);
	}

	clearSchema(): void {
		this.schema = [];
		const file = this.currentFile;
		if (file && detectInputFormat(file.name)) this.open(file);
		else this.closeFile();
	}

	private closeFile(): void {
		this.schemaView = null;
		this.currentFile = null;
		this.hasDoc = false;
		this.fileName = '';
		this.fileSize = 0;
		this.error = null;
		this.confirm = null;
		this.status = 'idle';
		this.runId++;
		this.resetView(this.outputLanguage());
	}

	/** Reset the editor and forget navigation state that referred to its old text. */
	private resetView(language: string): void {
		this.location = null;
		this.labels = new Map();
		this.position = 1;
		this.sink?.reset(language);
	}

	private outputLanguage(): string {
		return outputFormats.find((f) => f.id === this.outputFormat)?.language ?? 'json';
	}

	open(file: File): void {
		this.schemaView = null;
		this.currentFile = file;
		this.hasDoc = false;
		this.error = null;
		this.confirm = null;
		this.fileName = file.name;
		this.fileSize = file.size;
		this.status = 'loading';
		this.runId++; // invalidate any in-flight chunks
		this.resetView(this.outputLanguage());
		this.client?.send({
			type: 'open',
			file,
			schema: this.schema.length ? this.schema : undefined
		});
	}

	render(opts: { truncateTo?: number | null; force?: boolean } = {}): void {
		this.runId++;
		this.confirm = null;
		this.error = null;
		this.status = 'rendering';
		this.truncated = opts.truncateTo != null;
		this.client?.send({
			type: 'render',
			runId: this.runId,
			format: this.outputFormat,
			truncateTo: opts.truncateTo ?? null,
			force: opts.force ?? false
		});
	}

	setFormat(id: string): void {
		if (id === this.outputFormat && !this.schemaView) return;
		this.outputFormat = id;
		this.closeSchemaView();
	}

	/** Show a schema's source in the editor instead of the output. */
	viewSchema(title: string, language: string, text: string): void {
		this.client?.send({ type: 'cancel', runId: this.runId });
		this.runId++; // ignore whatever the worker was still sending
		this.confirm = null;
		this.schemaView = { title, language };
		this.resetView(language);
		void this.sink?.append(text);
	}

	/** Leave the schema view and show the output again (re-rendered from the open file). */
	closeSchemaView(): void {
		const wasViewing = this.schemaView !== null;
		this.schemaView = null;
		if (this.hasDoc) this.render();
		else if (wasViewing) this.resetView(this.outputLanguage());
	}

	// ------------------------------------------------------------------ navigation

	/** Whether the worker can answer structure questions about what's on screen. */
	get canNavigate(): boolean {
		return this.hasDoc && !this.schemaView && this.outputFormat !== 'hex';
	}

	/** Whether the "go to" box does anything: paths for text views, byte offsets for hex. */
	get canGoTo(): boolean {
		return this.hasDoc && !this.schemaView;
	}

	private ask(query: Query): Promise<QueryResult | null> {
		const client = this.client;
		if (!client || !this.canNavigate) return Promise.resolve(null);
		const id = this.nextQueryId++;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			client.send({ type: 'query', id, query });
		});
	}

	/** Jump to what `text` names: a path, a bare field, `#12`, or a name; a byte offset in hex. */
	async goTo(text: string): Promise<GoResult> {
		if (this.outputFormat === 'hex') return this.goToOffset(text);
		const result = await this.ask({ op: 'go', text, line: this.position });
		if (!result) return { kind: 'error', message: 'Navigation isn’t available right now.' };
		if (result.kind === 'target') return this.show(result.target);
		return result.kind === 'choices' || result.kind === 'error'
			? result
			: { kind: 'error', message: 'Unexpected answer.' };
	}

	/** Move to the next/previous element of the list you're in, or to the parent. */
	async step(dir: 'next' | 'prev' | 'parent'): Promise<GoResult> {
		const result = await this.ask({ op: 'sibling', line: this.position, dir });
		if (result?.kind === 'target') return this.show(result.target);
		const failure: GoResult =
			result?.kind === 'error' ? result : { kind: 'error', message: 'Nothing to move to.' };
		this.flash(failure.kind === 'error' ? failure.message : '');
		return failure;
	}

	/** Show a short message for a few seconds. */
	private flash(message: string): void {
		this.notice = message;
		clearTimeout(this.timers.notice);
		this.timers.notice = setTimeout(() => (this.notice = null), 3500);
	}

	/** Scroll to a crumb or target, and make it the current position. */
	async show(target: Target): Promise<GoResult> {
		const ok = await this.sink?.reveal({
			line: target.line,
			endLine: target.endLine,
			refine: target.refine
		});
		if (!ok) {
			return {
				kind: 'error',
				message: 'That part of the output isn’t loaded yet. Try again in a moment.'
			};
		}
		this.setPosition(target.line, true);
		return { kind: 'target', target };
	}

	private async goToOffset(text: string): Promise<GoResult> {
		const m = /^(0x[0-9a-f]+|\d+)$/i.exec(text.trim());
		if (!m) return { kind: 'error', message: 'Type a byte offset like 0x1f40 or 8000.' };
		const offset = Number(m[1]);
		if (offset >= this.fileSize) {
			const last = Math.max(0, this.fileSize - 1);
			return { kind: 'error', message: `The file has ${this.fileSize} bytes (offsets 0–${last}).` };
		}
		const line = Math.floor(offset / 16) + 1;
		const target: Target = { line, endLine: line, path: `offset 0x${offset.toString(16)}` };
		const shown = await this.show(target);
		return shown.kind === 'target'
			? shown
			: {
					kind: 'error',
					message: 'That offset isn’t in the rendered output (it may be truncated).'
				};
	}

	async complete(text: string): Promise<Hint | null> {
		if (this.outputFormat === 'hex') {
			return { text: 'A byte offset, like 0x1f40 or 8000.', completions: [] };
		}
		const result = await this.ask({ op: 'complete', text });
		return result?.kind === 'hint' ? result.hint : null;
	}

	/** Report the line the reader is at (scrolling, clicking, jumping). `now` skips the debounce. */
	setPosition(line: number, now = false): void {
		this.position = line;
		clearTimeout(this.timers.location);
		if (now) void this.refreshLocation();
		else this.timers.location = setTimeout(() => void this.refreshLocation(), 60);
	}

	/** Report which lines are visible, so their index labels can be fetched. */
	setViewport(from: number, to: number): void {
		this.viewport = { from, to };
		clearTimeout(this.timers.labels);
		this.timers.labels = setTimeout(() => void this.refreshLabels(), 80);
	}

	async refreshLocation(): Promise<void> {
		const result = await this.ask({ op: 'pathAt', line: this.position });
		if (result?.kind === 'location') this.location = result.location;
		else if (!this.canNavigate) this.location = null;
	}

	async refreshLabels(): Promise<void> {
		if (!prefs.showIndices || !this.canNavigate) {
			if (this.labels.size) this.labels = new Map();
			return;
		}
		const result = await this.ask({ op: 'labels', ...this.viewport });
		if (result?.kind === 'labels') this.labels = new Map(result.labels);
	}

	chooseFull(): void {
		this.render({ force: true });
	}

	chooseTruncated(n: number = this.confirm?.truncateTo ?? TRUNCATE_TO): void {
		this.render({ truncateTo: n });
	}

	cancelConfirm(): void {
		this.confirm = null;
		this.status = 'idle';
	}

	private onMessage(msg: FromWorker): void {
		switch (msg.type) {
			case 'progress':
				this.phase = msg.phase;
				this.progress = { done: msg.done, total: msg.total };
				break;
			case 'opened':
				this.hasDoc = true;
				// While a schema is on screen, keep it there; leaving the view renders the file.
				if (this.schemaView) this.status = 'done';
				else this.render();
				break;
			case 'needsConfirm':
				if (msg.runId !== this.runId) break;
				this.confirm = msg;
				this.status = 'confirm';
				break;
			case 'renderStart':
				if (msg.runId !== this.runId) break;
				this.resetView(msg.language);
				break;
			case 'chunk':
				if (msg.runId !== this.runId) break;
				void this.sink?.append(msg.text).then(() => {
					this.client?.send({ type: 'ack', runId: msg.runId, seq: msg.seq });
				});
				break;
			case 'renderDone':
				if (msg.runId !== this.runId) break;
				this.status = 'done';
				this.phase = null;
				// Lines that arrived after the last viewport report can be labelled now.
				void this.refreshLabels();
				void this.refreshLocation();
				break;
			case 'answer': {
				const resolve = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				// An answer about an earlier render's text no longer applies to what's on screen.
				resolve?.(msg.runId === this.runId ? msg.result : null);
				break;
			}
			case 'error':
				if (msg.runId !== undefined && msg.runId !== this.runId) break;
				this.error = msg.message;
				this.status = 'error';
				this.phase = null;
				break;
		}
	}
}

export const session = new Session();
