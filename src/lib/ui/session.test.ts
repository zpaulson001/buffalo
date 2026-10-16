import { describe, expect, it } from 'vitest';
import type { FromWorker, ToWorker } from '../worker/protocol';
import { Session, type OutputSink } from './session.svelte';

function setup() {
	const sent: ToWorker[] = [];
	let emit: (msg: FromWorker) => void = () => {};
	const resets: string[] = [];
	const appended: string[] = [];
	const sink: OutputSink = {
		reset: (language) => void resets.push(language),
		append: async (text) => void appended.push(text)
	};
	const session = new Session((onMessage) => {
		emit = onMessage;
		return { send: (m) => void sent.push(m), terminate: () => {} };
	});
	session.attach(sink);
	const lastRender = () => sent.filter((m) => m.type === 'render').at(-1);
	return { session, sent, resets, appended, emit: (m: FromWorker) => emit(m), lastRender };
}

const file = (name: string, text = 'x') => new File([text], name);

describe('Session file handling', () => {
	it('opens a data file', async () => {
		const { session, sent } = setup();
		await session.openFiles([file('m.onnx')]);
		expect(session.status).toBe('loading');
		expect(session.fileName).toBe('m.onnx');
		expect(sent[0]).toMatchObject({ type: 'open', schema: undefined });
	});

	it('treats .fbs files as the schema and sends them with the data file', async () => {
		const { session, sent } = setup();
		await session.openFiles([file('a.fbs', 'table T {}'), file('data.bin')]);
		expect(session.schema).toEqual([{ name: 'a.fbs', text: 'table T {}' }]);
		expect(sent[0]).toMatchObject({ type: 'open', schema: [{ name: 'a.fbs' }] });
	});

	it('a schema alone re-reads the open file, or just waits if none', async () => {
		const { session, sent } = setup();
		await session.openFiles([file('a.fbs')]);
		expect(sent).toHaveLength(0);
		await session.openFiles([file('data.bin')]);
		await session.openFiles([file('b.fbs')]);
		expect(sent.filter((m) => m.type === 'open')).toHaveLength(2);
	});

	it('clearing the schema resets the view when the file has no known extension', async () => {
		const { session, resets } = setup();
		await session.openFiles([file('a.fbs'), file('data.bin')]);
		session.clearSchema();
		expect(session.schema).toEqual([]);
		expect(session.fileName).toBe('');
		expect(session.status).toBe('idle');
		expect(resets.length).toBeGreaterThan(0);
	});
});

describe('Session rendering', () => {
	it('renders when the worker has opened the file', async () => {
		const { session, emit, lastRender } = setup();
		await session.openFiles([file('m.onnx')]);
		emit({ type: 'opened', fileName: 'm.onnx', fileSize: 1, inputFormat: 'onnx' });
		expect(session.status).toBe('rendering');
		expect(lastRender()).toMatchObject({ format: 'json', truncateTo: null, force: false });
	});

	it('appends chunks and acknowledges them, ignoring stale runs', async () => {
		const { session, emit, sent, appended, resets, lastRender } = setup();
		await session.openFiles([file('m.onnx')]);
		emit({ type: 'opened', fileName: 'm.onnx', fileSize: 1, inputFormat: 'onnx' });
		const runId = (lastRender() as { runId: number }).runId;
		emit({ type: 'renderStart', runId, language: 'json', estimateChars: 10 });
		emit({ type: 'chunk', runId, seq: 0, text: 'abc' });
		emit({ type: 'chunk', runId: runId - 1, seq: 0, text: 'stale' });
		await Promise.resolve();
		await Promise.resolve();
		expect(resets.at(-1)).toBe('json');
		expect(appended).toEqual(['abc']);
		expect(sent.filter((m) => m.type === 'ack')).toEqual([{ type: 'ack', runId, seq: 0 }]);
		emit({ type: 'renderDone', runId, chars: 3, truncated: false });
		expect(session.status).toBe('done');
	});

	it('asks before rendering something huge, then honours the choice', async () => {
		const { session, emit, lastRender } = setup();
		await session.openFiles([file('m.onnx')]);
		emit({ type: 'opened', fileName: 'm.onnx', fileSize: 1, inputFormat: 'onnx' });
		const runId = (lastRender() as { runId: number }).runId;
		emit({
			type: 'needsConfirm',
			runId,
			fullChars: 9e8,
			truncatedChars: 1e4,
			limit: 2e8,
			truncateTo: 1000,
			truncateLabel: 'values of each tensor'
		});
		expect(session.status).toBe('confirm');
		expect(session.confirm?.truncateTo).toBe(1000);

		session.chooseTruncated(50);
		expect(lastRender()).toMatchObject({ truncateTo: 50, force: false });
		expect(session.truncated).toBe(true);
		expect(session.confirm).toBeNull();

		session.chooseFull();
		expect(lastRender()).toMatchObject({ truncateTo: null, force: true });
	});

	it('re-renders in the new format without re-opening the file', async () => {
		const { session, emit, sent, lastRender } = setup();
		await session.openFiles([file('m.onnx')]);
		emit({ type: 'opened', fileName: 'm.onnx', fileSize: 1, inputFormat: 'onnx' });
		session.setFormat('hex');
		expect(lastRender()).toMatchObject({ format: 'hex' });
		expect(sent.filter((m) => m.type === 'open')).toHaveLength(1);
	});

	it('shows worker errors', async () => {
		const { session, emit } = setup();
		await session.openFiles([file('m.onnx')]);
		emit({ type: 'error', message: 'bad file' });
		expect(session.status).toBe('error');
		expect(session.error).toBe('bad file');
	});
});

describe('Session schema view', () => {
	it('shows a schema, cancelling any render in progress', async () => {
		const { session, emit, sent, resets, appended, lastRender } = setup();
		await session.openFiles([file('m.onnx')]);
		emit({ type: 'opened', fileName: 'm.onnx', fileSize: 1, inputFormat: 'onnx' });
		const runId = (lastRender() as { runId: number }).runId;

		session.viewSchema('onnx.proto', 'proto', 'message X {}');
		expect(sent.at(-1)).toEqual({ type: 'cancel', runId });
		expect(session.schemaView).toEqual({ title: 'onnx.proto', language: 'proto' });
		expect(resets.at(-1)).toBe('proto');
		expect(appended.at(-1)).toBe('message X {}');

		// Chunks from the cancelled run are ignored.
		emit({ type: 'chunk', runId, seq: 0, text: 'late' });
		expect(appended).not.toContain('late');
	});

	it('works with no file open, and Close just clears the editor', () => {
		const { session, resets } = setup();
		session.viewSchema('schema.fbs', 'fbs', 'table T {}');
		session.closeSchemaView();
		expect(session.schemaView).toBeNull();
		expect(resets.at(-1)).toBe('json');
	});

	it('picking an output format leaves the schema view and renders the file', async () => {
		const { session, emit, lastRender } = setup();
		await session.openFiles([file('m.onnx')]);
		emit({ type: 'opened', fileName: 'm.onnx', fileSize: 1, inputFormat: 'onnx' });
		session.viewSchema('onnx.proto', 'proto', 'x');
		session.setFormat('json'); // same format as before still leaves the view
		expect(session.schemaView).toBeNull();
		expect(session.status).toBe('rendering');
		expect(lastRender()).toMatchObject({ format: 'json' });
	});

	it('keeps the schema on screen when a file finishes opening, until the view is closed', async () => {
		const { session, emit, sent } = setup();
		await session.openFiles([file('m.onnx')]);
		session.viewSchema('onnx.proto', 'proto', 'x');
		emit({ type: 'opened', fileName: 'm.onnx', fileSize: 1, inputFormat: 'onnx' });
		expect(sent.some((m) => m.type === 'render')).toBe(false);
		session.closeSchemaView();
		expect(sent.some((m) => m.type === 'render')).toBe(true);
	});

	it('opening a new file leaves the schema view', async () => {
		const { session } = setup();
		session.viewSchema('onnx.proto', 'proto', 'x');
		await session.openFiles([file('m.onnx')]);
		expect(session.schemaView).toBeNull();
	});
});
