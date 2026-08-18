import { APP_NAME, themeCssVariables } from './tokens.js';

/**
 * Installs the theme and the product name onto a document.
 *
 * Called once at startup. Everything a stylesheet needs arrives as a custom
 * property on `:root`, which is what lets `tokens.ts` stay the only place any
 * design value is written.
 */
export function applyTheme(doc: Document = document): void {
    const root = doc.documentElement;

    for (const [name, value] of Object.entries(themeCssVariables())) {
        root.style.setProperty(name, value);
    }

    // The one place the product name reaches the document. index.html ships an
    // empty <title> precisely so this is not a second copy of it.
    doc.title = APP_NAME;
}

/**
 * Whether the user has asked for less motion.
 *
 * The handoff is specific about what "honoring" it means here: drop the
 * animation, keep the static glow. A dot that stops glowing entirely would read
 * as "off" rather than "healthy and not busy", so reduced motion must not
 * become reduced information.
 */
export function prefersReducedMotion(win: Window = window): boolean {
    return win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Reflects the motion preference as an attribute the stylesheet can select on,
 * and keeps it current if the user changes it while the app is open.
 *
 * @returns an unsubscribe function.
 */
export function watchReducedMotion(win: Window = window, doc: Document = document): () => void {
    const query = win.matchMedia('(prefers-reduced-motion: reduce)');

    const sync = (matches: boolean): void => {
        doc.documentElement.dataset['reducedMotion'] = matches ? 'true' : 'false';
    };

    sync(query.matches);
    const onChange = (event: MediaQueryListEvent): void => { sync(event.matches); };
    query.addEventListener('change', onChange);

    return () => { query.removeEventListener('change', onChange); };
}
