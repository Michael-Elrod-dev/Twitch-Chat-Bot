import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyTheme, watchReducedMotion } from './theme/applyTheme.js';
import { resolvePlatform } from './platform/tauri.js';
import { APP_NAME } from './theme/tokens.js';
import './theme/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

applyTheme();
watchReducedMotion();

void (async () => {
    const platform = await resolvePlatform();

    // The window title comes from the same constant as everything else. It is
    // not visible under custom decorations, but it is what the taskbar and
    // Alt-Tab read.
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setTitle(APP_NAME);
    }

    createRoot(container).render(
        <StrictMode>
            <App platform={platform} />
        </StrictMode>
    );
})();
