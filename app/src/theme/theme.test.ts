import { describe, it, expect, vi } from 'vitest';
import { APP_NAME, colors, motion, themeCssVariables, type ThemeTokens } from './tokens.js';
import { applyTheme, prefersReducedMotion, watchReducedMotion } from './applyTheme.js';

/**
 * The theme module is the single source for every design value, so what is
 * worth testing is exactly that: that the constants reach the document, and
 * that the product name has only one home.
 */

describe('design tokens', () => {
    it('exposes every token group as a CSS custom property', () => {
        const vars = themeCssVariables();

        expect(vars['--color-app-background']).toBe('#171614');
        expect(vars['--color-accent']).toBe('#c8663f');
        expect(vars['--color-success']).toBe('#7f9c6e');
        expect(vars['--font-mono']).toContain('JetBrains Mono');
        expect(vars['--space-rail-width']).toBe('64px');
        expect(vars['--radius-pill']).toBe('999px');
        expect(vars['--motion-ok-glow-duration']).toBe(motion.okGlowDuration);
    });

    it('names every color it defines', () => {
        // Guards the kebab-casing: a token added in camelCase but emitted under
        // a mangled name would be invisible to the stylesheet and silently
        // fall back to nothing.
        const vars = themeCssVariables();
        const groups: ThemeTokens['colors'] = colors;

        for (const key of Object.keys(groups)) {
            const cssName = `--color-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
            expect(vars[cssName], `${key} is missing from the emitted variables`).toBeDefined();
        }
    });

    it('writes the tokens and the product name onto the document', () => {
        applyTheme(document);

        expect(document.documentElement.style.getPropertyValue('--color-card-surface'))
            .toBe('#1e1c1a');
        expect(document.title).toBe(APP_NAME);
    });

});

describe('prefers-reduced-motion', () => {
    const fakeWindow = (matches: boolean): { win: Window; fire: (next: boolean) => void } => {
        const listeners: ((e: MediaQueryListEvent) => void)[] = [];
        const query = {
            matches,
            addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => { listeners.push(fn); },
            removeEventListener: vi.fn()
        };
        return {
            win: { matchMedia: () => query } as unknown as Window,
            fire: (next: boolean) => {
                query.matches = next;
                for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
            }
        };
    };

    it('reports the preference', () => {
        expect(prefersReducedMotion(fakeWindow(true).win)).toBe(true);
        expect(prefersReducedMotion(fakeWindow(false).win)).toBe(false);
    });

    it('reflects the preference onto the root element', () => {
        const { win } = fakeWindow(true);
        watchReducedMotion(win, document);

        expect(document.documentElement.dataset['reducedMotion']).toBe('true');
    });

    it('follows a change made while the app is open', () => {
        const { win, fire } = fakeWindow(false);
        watchReducedMotion(win, document);
        expect(document.documentElement.dataset['reducedMotion']).toBe('false');

        fire(true);
        expect(document.documentElement.dataset['reducedMotion']).toBe('true');
    });

    it('unsubscribes', () => {
        const { win } = fakeWindow(false);
        const off = watchReducedMotion(win, document);
        off();

        const query = win.matchMedia('(prefers-reduced-motion: reduce)');
        expect(query.removeEventListener).toHaveBeenCalled();
    });
});
