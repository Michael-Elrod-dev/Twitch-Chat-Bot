// vitest/config, not vite: it is the one that knows about the `test` block.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

/**
 * The app's version, read from the one file that already holds it.
 *
 * The account screen renders a version beside a `CURRENT` chip and the auth
 * screens print one at the bottom. Both used a hand-written constant, which is
 * the kind of copy that reads `v0.1.0` for the rest of the product's life: a
 * release bumps `package.json` and `tauri.conf.json`, and nothing makes the
 * string in the UI follow. Defined here so a build cannot ship a version number
 * that disagrees with the build it is in.
 */
const packageVersion = (JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }).version;

/**
 * Vite for a Tauri front end.
 *
 * The dev server is fixed and non-strict-port on purpose: Tauri's dev command
 * points a webview at exactly this URL, and a port that silently moved would
 * leave the window staring at nothing.
 */
export default defineConfig({
    plugins: [react()],

    define: {
        __APP_VERSION__: JSON.stringify(packageVersion)
    },

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
