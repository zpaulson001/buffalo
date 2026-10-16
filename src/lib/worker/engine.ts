import { chunked } from '../core/chunker';
import { CHUNK_CHARS, MAX_INFLIGHT_CHUNKS, MAX_OUTPUT_BYTES } from '../core/config';
import { getOutputFormat, resolveInputFormat, supportedExtensions } from '../core/formats';
import type { SchemaSource } from '../core/input/flatbuffers';
import type { Node } from '../core/model';
import type { FromWorker, ToWorker } from './protocol';

interface OpenDoc {
	root: Node;
	bytes: Uint8Array;
}

const PROGRESS_STEP = 8 * 1024 * 1024;

/**
 * All worker logic, with no dependency on the worker global scope: feed it
 * messages via `handle`, it reports through `post`. Keeps it testable in Node.
 */
export class Engine {
	private doc: OpenDoc | null = null;
	private openToken = 0;
	private activeRun = 0;
	private ackedSeq = -1;
	private wake: (() => void) | null = null;

	constructor(private post: (msg: FromWorker) => void) {}

	handle(msg: ToWorker): void {
		switch (msg.type) {
			case 'open':
				this.activeRun = 0;
				this.signal();
				void this.open(msg.file, msg.schema).catch((e) => this.fail(e));
				break;
			case 'render':
				void this.render(msg).catch((e) => this.fail(e, msg.runId));
				break;
			case 'ack':
				if (msg.runId === this.activeRun) this.ackedSeq = Math.max(this.ackedSeq, msg.seq);
				this.signal();
				break;
			case 'cancel':
				if (msg.runId === this.activeRun) this.activeRun = 0;
				this.signal();
				break;
		}
	}

	private fail(e: unknown, runId?: number): void {
		this.post({ type: 'error', runId, message: e instanceof Error ? e.message : String(e) });
	}

	private signal(): void {
		const w = this.wake;
		this.wake = null;
		w?.();
	}

	private waitForMessage(): Promise<void> {
		return new Promise((resolve) => (this.wake = resolve));
	}

	private async open(file: File, schema?: SchemaSource[]): Promise<void> {
		const token = ++this.openToken;
		this.doc = null;
		const format = resolveInputFormat(file.name, schema);
		if (!format) {
			throw new Error(
				`Unsupported file type "${file.name}". Supported: ${supportedExtensions().join(', ')}. ` +
					`For other FlatBuffers files, drop a .fbs schema first.`
			);
		}

		const bytes = new Uint8Array(file.size);
		const reader = file.stream().getReader();
		let offset = 0;
		let lastReported = 0;
		this.post({ type: 'progress', phase: 'read', done: 0, total: file.size });
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (token !== this.openToken) {
				void reader.cancel();
				return;
			}
			bytes.set(value, offset);
			offset += value.length;
			if (offset - lastReported >= PROGRESS_STEP) {
				lastReported = offset;
				this.post({ type: 'progress', phase: 'read', done: offset, total: file.size });
			}
		}

		// Decoding is one synchronous call, so progress is indeterminate.
		this.post({ type: 'progress', phase: 'decode', done: 0, total: 0 });
		const root = format.decode(bytes);
		if (token !== this.openToken) return;
		this.doc = { root, bytes };
		this.post({ type: 'opened', fileName: file.name, fileSize: file.size, inputFormat: format.id });
	}

	private async render(req: Extract<ToWorker, { type: 'render' }>): Promise<void> {
		const { runId } = req;
		const doc = this.doc;
		if (!doc) throw new Error('No file is open.');
		const format = getOutputFormat(req.format);
		if (!format) throw new Error(`Unknown output format "${req.format}".`);

		this.activeRun = runId;
		this.ackedSeq = -1;
		this.signal();

		this.post({ type: 'progress', phase: 'estimate', done: 0, total: 0 });
		const ctx = { root: doc.root, bytes: doc.bytes };
		const truncateTo = req.truncateTo;
		const fullChars = format.estimate(ctx, { truncateTo: null });

		if (truncateTo == null && !req.force && fullChars > MAX_OUTPUT_BYTES) {
			this.post({
				type: 'needsConfirm',
				runId,
				fullChars,
				truncatedChars: format.estimate(ctx, { truncateTo: format.truncate.defaultValue }),
				limit: MAX_OUTPUT_BYTES,
				truncateTo: format.truncate.defaultValue,
				truncateLabel: format.truncate.label
			});
			return;
		}

		const opts = { truncateTo };
		const estimateChars = truncateTo == null ? fullChars : format.estimate(ctx, opts);
		this.post({ type: 'renderStart', runId, language: format.language, estimateChars });

		let seq = 0;
		let chars = 0;
		for (const text of chunked(format.serialize(ctx, opts), CHUNK_CHARS)) {
			// Backpressure: wait until the UI has applied enough earlier chunks.
			while (this.activeRun === runId && seq - 1 - this.ackedSeq >= MAX_INFLIGHT_CHUNKS) {
				await this.waitForMessage();
			}
			if (this.activeRun !== runId) return; // cancelled or superseded
			this.post({ type: 'chunk', runId, seq: seq++, text });
			chars += text.length;
			this.post({ type: 'progress', phase: 'serialize', done: chars, total: estimateChars });
			// Let cancel/ack messages through between chunks.
			await new Promise((r) => setTimeout(r, 0));
		}
		if (this.activeRun !== runId) return;
		this.post({ type: 'renderDone', runId, chars, truncated: truncateTo != null });
	}
}
