import type { WindowControls } from '../shell/TitleBar.js';
import { setDefaultFetch } from '../api/client.js';

/**
 * Everything the app asks of the desktop shell.
 *
 * Behind an interface for two reasons: the component tests run in jsdom where
 * no Tauri runtime exists, and `npm run dev` in a plain browser should still
 * render the shell rather than crash on a missing global. Both fall back to
 * the no-op implementation below, which is honest about doing nothing rather
 * than pretending to minimize a window that is a browser tab.
 */

export interface Platform {
    controls: WindowControls;
    /** Opens a URL in the SYSTEM browser — never in an embedded webview. */
    openExternal: (url: string) => Promise<void>;
    /**
     * Registers a handler for `almosthadai://…` deep links.
     *
     * @returns an unsubscribe function.
     */
    onDeepLink: (handler: (url: string) => void) => Promise<() => void>;

    /**
     * Whether this machine will deliver the sign-in callback back to us.
     *
     * Asked BEFORE offering to sign in. If the scheme is not registered, Twitch
     * consent still succeeds and the server still redirects — to a URL Windows
     * cannot open. Nothing visibly fails; the user simply waits forever, and
     * each retry spends another single-use OAuth state, so the browser starts
     * answering "this authorization link is no longer valid" with no hint as to
     * why. Better to refuse the flow than to start one that cannot finish.
     */
    canReceiveCallback: () => Promise<boolean>;
}

export function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Used in the browser and in tests. Every operation is a deliberate no-op. */
export const noopPlatform: Platform = {
    controls: {
        minimize: () => undefined,
        toggleMaximize: () => undefined,
        close: () => undefined
    },
    openExternal: async (url) => {
        if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    },
    onDeepLink: async () => () => undefined,
    // A browser tab cannot receive a private-scheme callback, and saying "yes"
    // here is what lets someone run the flow in `npm run dev` and be baffled
    // when it never completes.
    canReceiveCallback: async () => false
};

/**
 * The real shell.
 *
 * Imported dynamically so the Tauri packages are never evaluated in a jsdom or
 * plain-browser run, where their module-level access to `__TAURI_INTERNALS__`
 * would throw before any of this could decide not to use them.
 */
export async function loadTauriPlatform(): Promise<Platform> {
    const [{ getCurrentWindow }, opener, deepLink, http] = await Promise.all([
        import('@tauri-apps/api/window'),
        import('@tauri-apps/plugin-opener'),
        import('@tauri-apps/plugin-deep-link'),
        import('@tauri-apps/plugin-http')
    ]);

    /*
     * Requests go through Rust from here on.
     *
     * The webview's origin is `http://tauri.localhost`, so a plain `fetch` to
     * the API is cross-origin and the server sends no CORS headers — every call
     * would be refused by the browser engine before leaving the machine. The
     * plugin performs the request outside the webview, where no origin policy
     * applies, which is narrower than teaching the server to accept requests
     * from arbitrary web pages.
     */
    setDefaultFetch(http.fetch as unknown as typeof fetch);

    const appWindow = getCurrentWindow();

    return {
        controls: {
            minimize: () => { void appWindow.minimize(); },
            toggleMaximize: () => { void appWindow.toggleMaximize(); },
            close: () => { void appWindow.close(); }
        },
        openExternal: async (url) => { await opener.openUrl(url); },
        canReceiveCallback: async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                return await invoke<boolean>('deep_link_registered');
            } catch {
                return false;
            }
        },
        onDeepLink: async (handler) => {
            // A cold start can carry the link that launched the app, and it
            // arrives before any listener exists — so both are checked.
            const initial = await deepLink.getCurrent();
            if (initial) for (const url of initial) handler(url);

            return await deepLink.onOpenUrl((urls) => {
                for (const url of urls) handler(url);
            });
        }
    };
}

export async function resolvePlatform(): Promise<Platform> {
    if (!isTauri()) return noopPlatform;
    try {
        return await loadTauriPlatform();
    } catch {
        // A shell that failed to load must not take the UI with it: the app is
        // still usable, it just cannot drive the window.
        return noopPlatform;
    }
}
