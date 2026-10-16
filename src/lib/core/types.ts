import type { Node } from './model';
import type { Marks } from './outline';

/** The schema an input format reads with, kept so it can be shown to the user. */
export interface BaseSchema {
	fileName: string;
	language: 'proto' | 'fbs';
	text: string;
}

export interface InputFormat {
	id: string;
	label: string;
	/** Schema files this format reads with, kept so they can be shown to the user. */
	baseSchemas?: BaseSchema[];
	/** Lower-case, with leading dot. */
	extensions: string[];
	decode(bytes: Uint8Array): Node;
}

export interface RenderContext {
	root: Node;
	/** The original file bytes (used by byte-oriented outputs such as hex). */
	bytes: Uint8Array;
}

export interface RenderOptions {
	/** Keep only the first N units (see OutputFormat.truncate); null = everything. */
	truncateTo: number | null;
}

export interface OutputFormat {
	id: string;
	label: string;
	/** Which editor language mode to use. */
	language: 'json' | 'prototext' | 'fbt' | 'hex';
	/** What "truncate" means for this format, offered when the output is too large. */
	truncate: {
		/** Completes "Keep the first N ...", e.g. "values of each tensor". */
		label: string;
		defaultValue: number;
	};
	/** Estimated number of characters `serialize` will produce. */
	estimate(ctx: RenderContext, opts: RenderOptions): number;
	/**
	 * Yields the output text in small strings. If `marks` is given, report the
	 * structure as it is written (see outline.ts) so the output can be navigated.
	 */
	serialize(ctx: RenderContext, opts: RenderOptions, marks?: Marks): Generator<string>;
}
