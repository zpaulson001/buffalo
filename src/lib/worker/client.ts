import type { FromWorker, ToWorker } from './protocol';

/** Thin typed wrapper over the parse Worker. */
export class WorkerClient {
	private worker: Worker;

	constructor(onMessage: (msg: FromWorker) => void) {
		this.worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
		this.worker.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data);
		this.worker.onerror = (e) =>
			onMessage({ type: 'error', message: e.message || 'Worker crashed' });
	}

	send(msg: ToWorker): void {
		this.worker.postMessage(msg);
	}

	terminate(): void {
		this.worker.terminate();
	}
}
