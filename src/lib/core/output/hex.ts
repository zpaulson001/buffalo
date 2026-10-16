import { HEX_TRUNCATE_BYTES } from '../config';
import type { OutputFormat, RenderContext, RenderOptions } from '../types';

/** `hexdump -C` style: offset, 16 bytes as hex in two groups of 8, then ASCII. */

const BYTES_PER_LINE = 16;
/** 8 offset + 2 + 16*3 + 1 group gap + 2 + |16 ascii| + newline. */
const CHARS_PER_LINE = 78;

const HEX: string[] = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0'));
const ASCII: string[] = Array.from({ length: 256 }, (_, b) =>
	b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'
);

function keptBytes(total: number, opts: RenderOptions): number {
	return opts.truncateTo == null ? total : Math.min(total, Math.max(0, opts.truncateTo));
}

export const hexFormat: OutputFormat = {
	id: 'hex',
	label: 'Hex',
	language: 'hex',
	truncate: { label: 'bytes of the file', defaultValue: HEX_TRUNCATE_BYTES },
	estimate(ctx: RenderContext, opts: RenderOptions) {
		const kept = keptBytes(ctx.bytes.length, opts);
		return Math.ceil(kept / BYTES_PER_LINE) * CHARS_PER_LINE + 64;
	},
	*serialize(ctx: RenderContext, opts: RenderOptions) {
		const bytes = ctx.bytes;
		const kept = keptBytes(bytes.length, opts);
		for (let off = 0; off < kept; off += BYTES_PER_LINE) {
			const end = Math.min(off + BYTES_PER_LINE, kept);
			let hex = '';
			let ascii = '';
			for (let i = off; i < off + BYTES_PER_LINE; i++) {
				if (i === off + 8) hex += ' ';
				if (i < end) {
					hex += HEX[bytes[i]] + ' ';
					ascii += ASCII[bytes[i]];
				} else {
					hex += '   ';
				}
			}
			yield `${off.toString(16).padStart(8, '0')}  ${hex} |${ascii}|\n`;
		}
		if (kept < bytes.length) yield `... ${bytes.length - kept} more bytes\n`;
	}
};
