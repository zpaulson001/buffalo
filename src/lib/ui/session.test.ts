import { describe, expect, it, vi } from 'vitest';
import type { Query, QueryResult } from '../core/navigate';
import type { FromWorker, ToWorker } from '../worker/protocol';
import { Session, type OutputSink, type RevealTarget } from './session.svelte';

function setup() {
	const sent: ToWorker[] = [];
	let emit: (msg: FromWorker) => void = () => {};
	const resets: string[] = [];
	const appended: string[] = [];
	const revealed: RevealTarget[] = [];
	const sink: OutputSink = {
		reset: (language) => void resets.push(language),
		append: async (text) => void appended.push(text),
		reveal: async (target) => {
			revealed.push(target);
			return true;
		}
	};
	const lastRender = () => sent.filter((m) => m.type === 'render').at(-1);
	// Queries are answered by `answerWith`, as the worker would, for the current render.
	let answerWith: (q: Query) => QueryResult | null = () => null;
	const session = new Session((onMessage) => {
		emit = onMessage;
		return {
			send: (m) => {
				sent.push(m);
				if (m.type !== 'query') return;
				const result = answerWith(m.query);
				const runId = (lastRender() as { runId: number } | undefined)?.runId ?? 0;
				if (result) queueMicrotask(() => onMessage({ type: 'answer', id: m.id, runId, result }));
			},
			terminate: () => {}
		};
	});
	session.attach(sink);
	return {
		session,
		sent,
		resets,
		appended,
		revealed,
		emit: (m: FromWorker) => emit(m),
		lastRender,
		answer: (fn: (q: Query) => QueryResult | null) => (answerWith = fn),
		queries: () => sent.flatMap((m) => (m.type === 'query' ? [m.query] : []))
	};
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

describe('Session navigation', () => {
	async function ready() {
		const h = setup();
		await h.session.openFiles([file('m.onnx', 'x'.repeat(1000))]);
		h.emit({ type: 'opened', fileName: 'm.onnx', fileSize: 1000, inputFormat: 'onnx' });
		return h;
	}
	const target = { line: 12, endLine: 20, path: 'graph.node[3]' };

	it('jumps to a path: asks the worker, reveals the target, and moves the position', async () => {
		const h = await ready();
		h.answer(() => ({ kind: 'target', target }));
		const result = await h.session.goTo('graph.node[3]');
		expect(result.kind).toBe('target');
		expect(h.queries()[0]).toEqual({ op: 'go', text: 'graph.node[3]', line: 1 });
		expect(h.revealed).toEqual([{ line: 12, endLine: 20, refine: undefined }]);
		expect(h.session.position).toBe(12);
	});

	it('passes the current position along, so #N is relative to where the reader is', async () => {
		const h = await ready();
		h.session.setPosition(77);
		h.answer(() => ({ kind: 'target', target }));
		await h.session.goTo('#5');
		expect(h.queries().find((q) => q.op === 'go')).toMatchObject({
			op: 'go',
			text: '#5',
			line: 77
		});
	});

	it('returns choices and errors without scrolling anywhere', async () => {
		const h = await ready();
		h.answer(() => ({
			kind: 'choices',
			title: '2 matches',
			choices: [{ label: 'a', detail: 'x', path: 'x' }],
			more: 1
		}));
		expect((await h.session.goTo('conv')).kind).toBe('choices');
		h.answer(() => ({ kind: 'error', message: 'graph has no field "nodes".' }));
		expect(await h.session.goTo('graph.nodes')).toMatchObject({ kind: 'error' });
		expect(h.revealed).toHaveLength(0);
	});

	it('reports when the target lines never arrive', async () => {
		const h = await ready();
		h.answer(() => ({ kind: 'target', target }));
		const original = h.revealed;
		const session = h.session as unknown as { sink: OutputSink };
		session.sink.reveal = async () => false;
		const result = await h.session.goTo('graph.node[3]');
		expect(result).toMatchObject({
			kind: 'error',
			message: expect.stringContaining('isn’t loaded')
		});
		expect(original).toHaveLength(0);
	});

	it('ignores answers about an earlier render', async () => {
		const h = setup();
		await h.session.openFiles([file('m.onnx')]);
		h.emit({ type: 'opened', fileName: 'm.onnx', fileSize: 1, inputFormat: 'onnx' });
		let id = 0;
		const original = h.sent.push.bind(h.sent);
		h.sent.push = (...items: ToWorker[]) => {
			for (const m of items) if (m.type === 'query') id = m.id;
			return original(...items);
		};
		const pending = h.session.goTo('graph');
		// The worker answers, but for a render that has since been replaced.
		const staleRun = (h.lastRender() as { runId: number }).runId - 1;
		h.emit({ type: 'answer', id, runId: staleRun, result: { kind: 'target', target } });
		expect(await pending).toMatchObject({ kind: 'error' });
		expect(h.revealed).toHaveLength(0);
	});

	it('steps to a sibling and shows a notice when there is none', async () => {
		const h = await ready();
		h.answer(() => ({ kind: 'target', target }));
		expect((await h.session.step('next')).kind).toBe('target');
		h.answer(() => ({ kind: 'error', message: 'That is the last item of graph.node.' }));
		vi.useFakeTimers();
		expect((await h.session.step('next')).kind).toBe('error');
		expect(h.session.notice).toBe('That is the last item of graph.node.');
		vi.advanceTimersByTime(4000);
		expect(h.session.notice).toBeNull();
		vi.useRealTimers();
	});

	it('tracks the breadcrumb for the reader’s position', async () => {
		const h = await ready();
		h.answer((q) =>
			q.op === 'pathAt'
				? {
						kind: 'location',
						location: { path: 'graph.node[2]', crumbs: [{ label: 'graph', line: 1, endLine: 99 }] }
					}
				: null
		);
		h.session.setPosition(30, true);
		await new Promise((r) => setTimeout(r, 0));
		expect(h.session.location?.path).toBe('graph.node[2]');
		expect(h.queries().at(-1)).toEqual({ op: 'pathAt', line: 30 });
	});

	it('fetches index labels for the visible lines', async () => {
		const h = await ready();
		h.answer((q) =>
			q.op === 'labels'
				? {
						kind: 'labels',
						labels: [
							[5, '[0]'],
							[9, '[1]']
						]
					}
				: null
		);
		await h.session.refreshLabels();
		expect(h.session.labels.get(9)).toBe('[1]');
		expect(h.queries().at(-1)).toMatchObject({ op: 'labels' });
	});

	it('clears location and labels when the editor is reset', async () => {
		const h = await ready();
		h.answer((q) =>
			q.op === 'labels'
				? { kind: 'labels', labels: [[5, '[0]']] }
				: { kind: 'location', location: { path: 'a', crumbs: [] } }
		);
		await h.session.refreshLabels();
		h.session.setPosition(3, true);
		await new Promise((r) => setTimeout(r, 0));
		expect(h.session.labels.size).toBe(1);
		const runId = (h.lastRender() as { runId: number }).runId;
		h.emit({ type: 'renderStart', runId, language: 'json', estimateChars: 1 });
		expect(h.session.labels.size).toBe(0);
		expect(h.session.location).toBeNull();
	});

	describe('hex view', () => {
		async function inHex() {
			const h = await ready();
			h.session.setFormat('hex');
			return h;
		}

		it('takes byte offsets and never asks the worker', async () => {
			const h = await inHex();
			expect(h.session.canNavigate).toBe(false);
			expect(h.session.canGoTo).toBe(true);
			const result = await h.session.goTo('0x20');
			expect(result.kind).toBe('target');
			expect(h.revealed.at(-1)).toMatchObject({ line: 3, endLine: 3 }); // 0x20 / 16 + 1
			expect(h.queries()).toHaveLength(0);
		});

		it('validates offsets', async () => {
			const h = await inHex();
			expect(await h.session.goTo('banana')).toMatchObject({ kind: 'error' });
			expect(await h.session.goTo('5000')).toMatchObject({
				kind: 'error',
				message: expect.stringContaining('1000 bytes')
			});
		});
	});

	it('is unavailable while a schema is on screen', async () => {
		const h = await ready();
		h.session.viewSchema('onnx.proto', 'proto', 'x');
		expect(h.session.canNavigate).toBe(false);
		expect(h.session.canGoTo).toBe(false);
	});
});
