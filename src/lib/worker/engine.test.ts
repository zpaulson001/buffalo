import * as flatbuffers from 'flatbuffers';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { buildTflite } from '../core/input/tflite/testing';
import protoSource from '../core/input/onnx/onnx.proto?raw';
import { MAX_INFLIGHT_CHUNKS } from '../core/config';
import { Engine } from './engine';
import type { FromWorker } from './protocol';

const { root } = protobuf.parse(protoSource, { keepCase: true });
const ModelProto = root.lookupType('onnx.ModelProto');

function modelFile(floatCount: number, name = 'm.onnx'): File {
	const floats = new Float32Array(floatCount);
	// Non-trivial values so the text output is long (zeros are only 3 chars each).
	if (floatCount <= 3_000_000) for (let i = 0; i < floatCount; i++) floats[i] = i * 0.123457;
	const raw = new Uint8Array(floats.buffer);
	const bytes = ModelProto.encode(
		ModelProto.fromObject({
			graph: { initializer: [{ name: 'w', dims: [floatCount], data_type: 1, raw_data: raw }] }
		})
	).finish();
	return new File([bytes as BlobPart], name);
}

function harness() {
	const msgs: FromWorker[] = [];
	const engine = new Engine((m) => msgs.push(m));
	const waitFor = async (pred: (m: FromWorker) => boolean, timeout = 15000) => {
		const t0 = Date.now();
		while (!msgs.some(pred)) {
			if (Date.now() - t0 > timeout) throw new Error('timeout; got ' + msgs.map((m) => m.type));
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	return { msgs, engine, waitFor };
}

describe('Engine', () => {
	it('opens a file, renders, and finishes', async () => {
		const { msgs, engine, waitFor } = harness();
		engine.handle({ type: 'open', file: modelFile(100) });
		await waitFor((m) => m.type === 'opened');
		engine.handle({ type: 'render', runId: 1, format: 'json', truncateTo: null, force: false });
		await waitFor((m) => m.type === 'renderDone');
		const text = msgs.flatMap((m) => (m.type === 'chunk' ? [m.text] : [])).join('');
		expect(JSON.parse(text).graph.initializer[0].data.values).toHaveLength(100);
		expect(msgs.some((m) => m.type === 'progress' && m.phase === 'read')).toBe(true);
	});

	it('opens a .tflite immediately, with no schema supplied', async () => {
		const { msgs, engine, waitFor } = harness();
		const file = new File([buildTflite() as BlobPart], 'model.tflite');
		engine.handle({ type: 'open', file });
		await waitFor((m) => m.type === 'opened');
		engine.handle({ type: 'render', runId: 1, format: 'json', truncateTo: null, force: false });
		await waitFor((m) => m.type === 'renderDone');
		const text = msgs.flatMap((m) => (m.type === 'chunk' ? [m.text] : [])).join('');
		expect(JSON.parse(text).subgraphs[0].tensors).toHaveLength(5);
	});

	it('reads any FlatBuffers file with a user-supplied schema, whatever its extension', async () => {
		const { msgs, engine, waitFor } = harness();
		const schema = [
			{
				name: 'tiny.fbs',
				text: 'table T { v: int; s: string; } root_type T; file_identifier "TINY";'
			}
		];
		const b = new flatbuffers.Builder(64);
		const s = b.createString('hi');
		b.startObject(2);
		b.addFieldInt32(0, 7, 0);
		b.addFieldOffset(1, s, 0);
		b.finish(b.endObject(), 'TINY');
		const file = new File([b.asUint8Array() as BlobPart], 'data.bin');
		engine.handle({ type: 'open', file, schema });
		await waitFor((m) => m.type === 'opened');
		engine.handle({ type: 'render', runId: 1, format: 'json', truncateTo: null, force: false });
		await waitFor((m) => m.type === 'renderDone');
		const text = msgs.flatMap((m) => (m.type === 'chunk' ? [m.text] : [])).join('');
		expect(JSON.parse(text)).toEqual({ v: 7, s: 'hi' });
	});

	it('reports schema errors with the file and line', async () => {
		const { engine, waitFor, msgs } = harness();
		const schema = [{ name: 'bad.fbs', text: 'table T {\n  v int;\n}' }];
		engine.handle({ type: 'open', file: new File([new Uint8Array(16)], 'x.bin'), schema });
		await waitFor((m) => m.type === 'error');
		expect(msgs.find((m) => m.type === 'error')).toMatchObject({
			message: expect.stringMatching(/bad\.fbs:2/)
		});
	});

	it('reports an error for unsupported file types', async () => {
		const { engine, waitFor, msgs } = harness();
		engine.handle({ type: 'open', file: new File([new Uint8Array(4)], 'x.bin') });
		await waitFor((m) => m.type === 'error');
		expect(msgs.find((m) => m.type === 'error')).toMatchObject({
			message: expect.stringContaining('.onnx')
		});
	});

	it('asks for confirmation when output would exceed the limit, then truncates', async () => {
		const { msgs, engine, waitFor } = harness();
		engine.handle({ type: 'open', file: modelFile(30_000_000) }); // ~360M chars estimated
		await waitFor((m) => m.type === 'opened', 60000);
		engine.handle({ type: 'render', runId: 1, format: 'json', truncateTo: null, force: false });
		await waitFor((m) => m.type === 'needsConfirm');
		expect(msgs.some((m) => m.type === 'chunk')).toBe(false);

		engine.handle({ type: 'render', runId: 2, format: 'json', truncateTo: 50, force: false });
		await waitFor((m) => m.type === 'renderDone' && m.runId === 2);
		const text = msgs
			.flatMap((m) => (m.type === 'chunk' && m.runId === 2 ? [m.text] : []))
			.join('');
		const values = JSON.parse(text).graph.initializer[0].data.values;
		expect(values).toHaveLength(51);
		expect(values[50]).toBe('... 29999950 more values');
	}, 90000);

	it('stops sending chunks until the UI acknowledges them', async () => {
		const { msgs, engine, waitFor } = harness();
		engine.handle({ type: 'open', file: modelFile(2_000_000) }); // ~20M+ chars = many chunks
		await waitFor((m) => m.type === 'opened');
		engine.handle({ type: 'render', runId: 1, format: 'json', truncateTo: null, force: true });
		const chunks = () => msgs.filter((m) => m.type === 'chunk').length;
		while (chunks() < MAX_INFLIGHT_CHUNKS) await new Promise((r) => setTimeout(r, 10));
		await new Promise((r) => setTimeout(r, 300)); // it must not send more than the window
		expect(chunks()).toBe(MAX_INFLIGHT_CHUNKS);
		expect(msgs.some((m) => m.type === 'renderDone')).toBe(false);

		// Acknowledge everything as it arrives.
		let acked = -1;
		while (!msgs.some((m) => m.type === 'renderDone')) {
			for (const m of msgs) {
				if (m.type === 'chunk' && m.seq > acked) {
					acked = m.seq;
					engine.handle({ type: 'ack', runId: 1, seq: m.seq });
				}
			}
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(chunks()).toBeGreaterThan(MAX_INFLIGHT_CHUNKS);
	}, 60000);

	it('cancel stops a run', async () => {
		const { msgs, engine, waitFor } = harness();
		engine.handle({ type: 'open', file: modelFile(2_000_000) });
		await waitFor((m) => m.type === 'opened');
		engine.handle({ type: 'render', runId: 1, format: 'json', truncateTo: null, force: true });
		await waitFor((m) => m.type === 'chunk');
		engine.handle({ type: 'cancel', runId: 1 });
		const n = msgs.filter((m) => m.type === 'chunk').length;
		await new Promise((r) => setTimeout(r, 100));
		expect(msgs.filter((m) => m.type === 'chunk').length).toBeLessThanOrEqual(n + 1);
		expect(msgs.some((m) => m.type === 'renderDone')).toBe(false);
	});
});
