import type { SchemaSource } from '../core/input/flatbuffers';

/** Messages between the UI thread and the parse worker. Types only. */

export type Phase = 'read' | 'decode' | 'estimate' | 'serialize';

export type ToWorker =
	/** `schema`: user-supplied .fbs sources; when set, the file is read as FlatBuffers with them. */
	| { type: 'open'; file: File; schema?: SchemaSource[] }
	/**
	 * Render the opened document. Without `truncateTo`/`force`, the worker answers
	 * `needsConfirm` instead of rendering if the output would exceed the size limit.
	 */
	| { type: 'render'; runId: number; format: string; truncateTo: number | null; force: boolean }
	/** The UI has applied chunk `seq` of run `runId`; lets the worker send more. */
	| { type: 'ack'; runId: number; seq: number }
	| { type: 'cancel'; runId: number };

export type FromWorker =
	/** `total` of 0 means indeterminate. */
	| { type: 'progress'; phase: Phase; done: number; total: number }
	| { type: 'opened'; fileName: string; fileSize: number; inputFormat: string }
	| {
			type: 'needsConfirm';
			runId: number;
			fullChars: number;
			truncatedChars: number;
			limit: number;
			truncateTo: number;
			/** Completes "Keep the first N ...". */
			truncateLabel: string;
	  }
	| { type: 'renderStart'; runId: number; language: string; estimateChars: number }
	| { type: 'chunk'; runId: number; seq: number; text: string }
	| { type: 'renderDone'; runId: number; chars: number; truncated: boolean }
	| { type: 'error'; runId?: number; message: string };
