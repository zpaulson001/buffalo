import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// SPA mode: every route falls back to index.html, served as plain static files.
			adapter: adapter({ fallback: 'index.html' })
		})
	],
	worker: { format: 'es' },
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
