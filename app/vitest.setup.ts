import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom does not implement `matchMedia`, and the theme asks it about
 * `prefers-reduced-motion` on mount. A stub that reports "no preference" is the
 * honest default; tests that care about the reduced-motion path override it.
 */
Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
    })
});

afterEach(() => {
    cleanup();
});
