const SLICE_BYTES = 3 * 16384; // multiple of 3 so slices concatenate without padding

type WithToBase64 = Uint8Array & { toBase64?: () => string };

/** Base64 of `bytes` in pieces, so huge buffers never become one giant string. */
export function* base64Chunks(bytes: Uint8Array): Generator<string> {
	for (let i = 0; i < bytes.length; i += SLICE_BYTES) {
		const slice = bytes.subarray(i, i + SLICE_BYTES) as WithToBase64;
		yield typeof slice.toBase64 === 'function'
			? slice.toBase64()
			: btoa(String.fromCharCode.apply(null, slice as unknown as number[]));
	}
}

export function base64Length(byteLength: number): number {
	return Math.ceil(byteLength / 3) * 4;
}
