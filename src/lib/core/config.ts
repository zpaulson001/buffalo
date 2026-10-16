/**
 * Tunables for the viewer. Everything a user might reasonably want to change
 * lives here.
 */

/**
 * Size guard: if the estimated output exceeds this many characters, the user is
 * asked whether to show everything or truncate tensors. (~200 MB)
 */
export const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;

/** Default number of values kept per tensor when the user chooses to truncate. */
export const TRUNCATE_TO = 1000;

/** Default number of bytes kept when the user chooses to truncate the hex view. */
export const HEX_TRUNCATE_BYTES = 1024 * 1024;

/** Target size of each chunk of output text posted from the worker (characters). */
export const CHUNK_CHARS = 1 << 20;

/** Max chunks the worker may have posted that the UI hasn't applied yet. */
export const MAX_INFLIGHT_CHUNKS = 8;

/** Numeric tensor values per output line (arrays at most this long stay inline). */
export const VALUES_PER_LINE = 16;

/** Lists of primitives up to this long are printed on a single line. */
export const INLINE_LIST_MAX = 8;

/**
 * Navigation index: max containers (objects, lists, arrays) recorded per render.
 * Each costs ~21 bytes, so this caps the index at ~40 MB. Past it, deeper levels
 * stop being navigable but the output itself is unaffected.
 */
export const MAX_OUTLINE_RECORDS = 2_000_000;

/** Max results listed for name searches and ambiguous paths. */
export const SEARCH_RESULT_LIMIT = 30;

/** Fields whose string value identifies an element, for "go to by name". */
export const NAME_KEYS = ['name'];
