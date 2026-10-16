export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'buffalo-theme';
const MODES: ThemeMode[] = ['light', 'dark', 'system'];

/**
 * Light / dark / system. The choice is kept in localStorage (best effort: it
 * can be blocked or empty) and applied as a `dark` class on <html>, which
 * Tailwind's `dark:` variant keys off. app.html applies it before first paint.
 */
class Theme {
	mode = $state<ThemeMode>('system');
	private systemDark = $state(false);

	get dark(): boolean {
		return this.mode === 'dark' || (this.mode === 'system' && this.systemDark);
	}

	/** Call once on mount; returns a cleanup function. */
	init(): () => void {
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			if (MODES.includes(saved as ThemeMode)) this.mode = saved as ThemeMode;
		} catch {
			// Storage unavailable: keep the default.
		}
		const query = window.matchMedia('(prefers-color-scheme: dark)');
		this.systemDark = query.matches;
		const onChange = (e: MediaQueryListEvent) => {
			this.systemDark = e.matches;
			this.apply();
		};
		query.addEventListener('change', onChange);
		this.apply();
		return () => query.removeEventListener('change', onChange);
	}

	set(mode: ThemeMode): void {
		this.mode = mode;
		try {
			localStorage.setItem(STORAGE_KEY, mode);
		} catch {
			// Not persisted, still applied for this session.
		}
		this.apply();
	}

	private apply(): void {
		const root = document.documentElement;
		root.classList.toggle('dark', this.dark);
		root.style.colorScheme = this.dark ? 'dark' : 'light';
	}
}

export const theme = new Theme();
