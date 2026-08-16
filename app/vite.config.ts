// vitest/config, not vite: it is the one that knows about the `test` block.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vite for a Tauri front end.
 *
 * The dev server is fixed and non-strict-port on purpose: Tauri's dev command
 * points a webview at exactly this URL, and a port that silently moved would
 * leave the window staring at nothing.
 */
export default defineConfig({
    plugins: [react()],

    // Tauri serves the built bundle from a custom protocol, so every asset
    // reference has to be relative rather than root-absolute.
    base: './',

    server: {
        port: 5173,
        strictPort: true
    },

    build: {
        outDir: 'dist',
        // Chromium-family only: the Windows webview is WebView2. Targeting
        // older syntax would ship transpilation nobody runs.
        target: 'chrome120',
        sourcemap: true
    },

    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./vitest.setup.ts'],
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        css: false
    }
});
