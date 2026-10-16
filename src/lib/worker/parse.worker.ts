import { Engine } from './engine';
import type { FromWorker, ToWorker } from './protocol';

const scope = self as unknown as {
	postMessage(msg: FromWorker): void;
	onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};

const engine = new Engine((msg) => scope.postMessage(msg));
scope.onmessage = (e) => engine.handle(e.data);
