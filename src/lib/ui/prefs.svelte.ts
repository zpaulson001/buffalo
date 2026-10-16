const INDEX_LABELS_KEY = 'buffalo-index-labels';

/** Small persisted preferences (localStorage is best effort: it can be blocked or empty). */
class Prefs {
	/** Show the `[n]` index column next to list elements and tensor rows. */
	showIndices = $state(true);

	init(): void {
		try {
			const saved = localStorage.getItem(INDEX_LABELS_KEY);
			if (saved === 'on' || saved === 'off') this.showIndices = saved === 'on';
		} catch {
			// Storage unavailable: keep the default.
		}
	}

	setShowIndices(on: boolean): void {
		this.showIndices = on;
		try {
			localStorage.setItem(INDEX_LABELS_KEY, on ? 'on' : 'off');
		} catch {
			// Not persisted, still applied for this session.
		}
	}
}

export const prefs = new Prefs();
