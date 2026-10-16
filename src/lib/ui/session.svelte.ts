import { detectInputFormat, outputFormats } from '../core/formats';
import type { SchemaSource } from '../core/input/flatbuffers';
import { TRUNCATE_TO } from '../core/config';
import { WorkerClient } from '../worker/client';
import type { FromWorker, Phase, ToWorker } from '../worker/protocol';

/** Where rendered text goes. Implemented by the CodeMirror component. */
export interface OutputSink {
	/** Clear the document and switch language mode. */
	reset(language: string): void;
	/** Append text; resolves once it has been applied to the editor. */
	append(text: string): Promise<void>;
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

	private currentFile: File | null = null;
	private hasDoc = false;
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
		this.sink?.reset(this.outputLanguage());
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
		this.sink?.reset(this.outputLanguage());
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
		this.sink?.reset(language);
		void this.sink?.append(text);
	}

	/** Leave the schema view and show the output again (re-rendered from the open file). */
	closeSchemaView(): void {
		const wasViewing = this.schemaView !== null;
		this.schemaView = null;
		if (this.hasDoc) this.render();
		else if (wasViewing) this.sink?.reset(this.outputLanguage());
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
				this.sink?.reset(msg.language);
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
				break;
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
