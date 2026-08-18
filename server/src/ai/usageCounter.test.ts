import { describe, it, expect } from 'vitest';
import { usageSuffix, withUsageSuffix } from './usageCounter.js';

/**
 * When the counter is shown, and when it is not.
 *
 * A cap in the unlimited range suppresses the counter for whoever holds one, so
 * nobody ever sees a count like `(2/999999)`. These pin that rule and the
 * near-the-cap shape the owner asked for.
 */
describe('the usage counter', () => {
    describe('the show/hide boundary', () => {
        // A cap of 15 keeps the boundary about `remaining`, not about the cap.
        const at = (used: number) => usageSuffix({ used, limit: 15 });

        it('says nothing while more than three remain', () => {
            expect(at(11)).toBeNull();  // 4 remaining
            expect(at(10)).toBeNull();  // 5
            expect(at(0)).toBeNull();   // 15
        });

        it('appears at exactly three remaining, and not one earlier', () => {
            // The boundary the spec pins: 4 is silence, 3 speaks.
            expect(at(11)).toBeNull();
            expect(at(12)).toBe('(3 left this stream)');
        });

        it('counts down through the last few', () => {
            expect(at(12)).toBe('(3 left this stream)');
            expect(at(13)).toBe('(2 left this stream)');
            expect(at(14)).toBe('(1 left this stream)');
        });

        it('names the final request rather than saying zero left', () => {
            // "(0 left this stream)" reads as a refusal; this one was answered.
            expect(at(15)).toBe('(last one this stream)');
        });

        it('does not go negative if usage somehow overshoots', () => {
            expect(at(99)).toBe('(last one this stream)');
        });
    });

    describe('unlimited caps', () => {
        it('never shows a counter, which is the regression itself', () => {
            /*
             * An allowance of 999,999 is a number chosen to mean "no limit",
             * and counting down from it is meaningless.
             */
            expect(usageSuffix({ used: 2, limit: 999_999 })).toBeNull();
            expect(usageSuffix({ used: 999_998, limit: 999_999 })).toBeNull();
            expect(usageSuffix({ used: 999_999, limit: 999_999 })).toBeNull();
        });

        it('treats any cap of a thousand or more as unlimited', () => {
            expect(usageSuffix({ used: 999, limit: 1000 })).toBeNull();
            // ...and one below that is an ordinary countable cap.
            expect(usageSuffix({ used: 999, limit: 999 })).toBe('(last one this stream)');
        });
    });

    describe('uniformity across roles', () => {
        it('warns a moderator on their larger cap exactly as it warns a viewer', () => {
            // The threshold is absolute, so "3 left" means the same thing on a
            // cap of 5 and a cap of 15. A proportional rule would warn one of
            // them far too early.
            expect(usageSuffix({ used: 2, limit: 5 })).toBe('(3 left this stream)');
            expect(usageSuffix({ used: 12, limit: 15 })).toBe('(3 left this stream)');
        });
    });

    describe('the threshold knob', () => {
        it('honors an override', () => {
            expect(usageSuffix({ used: 5, limit: 15, threshold: 10 })).toBe('(10 left this stream)');
            expect(usageSuffix({ used: 12, limit: 15, threshold: 0 })).toBeNull();
        });

        it('a threshold of zero still names the final request', () => {
            // Turning the counter "off" must not swallow the one message that
            // tells a viewer they are done.
            expect(usageSuffix({ used: 15, limit: 15, threshold: 0 })).toBe('(last one this stream)');
        });
    });

    describe('placement', () => {
        it('appends, leaving the answer first', () => {
            expect(withUsageSuffix('here is your answer', { used: 14, limit: 15 }))
                .toBe('here is your answer (1 left this stream)');
        });

        it('returns the answer untouched when nothing is shown', () => {
            expect(withUsageSuffix('here is your answer', { used: 1, limit: 15 }))
                .toBe('here is your answer');
        });
    });
});
