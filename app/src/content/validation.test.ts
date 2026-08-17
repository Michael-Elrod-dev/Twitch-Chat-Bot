import { describe, it, expect } from 'vitest';
import {
    chatTextSchema,
    commandNameSchema,
    emoteTriggerSchema,
    createQuoteSchema
} from '@almosthadai/shared';
import {
    QUOTE_MAX_LENGTH,
    REPLY_MAX_LENGTH,
    validateCommandName,
    validateEmoteTrigger,
    validateQuoteText,
    validateReply
} from './validation.js';

/**
 * THE VALIDATION MIRROR.
 *
 * The package's brief asks that "the zod schema and the UI agree, or a test
 * fails". The implementation makes disagreement structurally impossible — the
 * form runs the schema rather than restating it — so what these prove is that
 * the structure holds: for every input, the UI's verdict IS the schema's
 * verdict, and the form submits the value the SERVER would have stored rather
 * than the one the user typed.
 *
 * The table is driven off the schema itself. A test that hardcoded "!ok is
 * valid" would be a third opinion to keep in step; asking both sides the same
 * question and comparing the answers cannot drift.
 */

/** Inputs chosen to sit on every boundary the schema draws. */
const NAME_CASES = [
    '!discord',          // ordinary
    '!Discord',          // uppercase — must come back lowercased
    '  !discord  ',      // padded — trimmed before anything else
    'discord',           // no leading !
    '!has space',        // space in the middle
    '!',                 // just the mark, nothing after it
    '!a',                // exactly the 2-char minimum
    `!${'a'.repeat(63)}`, // exactly 64
    `!${'a'.repeat(64)}`, // one past 64
    '',                  // empty
    '!ÉMOJI'             // non-ascii, lowercased by the same rule
];

const REPLY_CASES = [
    'hello',
    '   ',
    '',
    'a'.repeat(500),
    'a'.repeat(501),
    '  padded  '
];

describe('the validation mirror', () => {
    describe('command names', () => {
        for (const raw of NAME_CASES) {
            it(`agrees with commandNameSchema on ${JSON.stringify(raw)}`, () => {
                const schema = commandNameSchema.safeParse(raw);
                const ui = validateCommandName(raw);

                expect(ui.ok).toBe(schema.success);
                if (schema.success) {
                    // The value submitted is the schema's OUTPUT — lowercased and
                    // trimmed. Submitting the raw text would store a name the
                    // chat pipeline, which looks up lowercased, could never match.
                    expect(ui.value).toBe(schema.data);
                }
            });
        }

        it('lowercases on submit, which is the whole point of using the schema', () => {
            expect(validateCommandName('!DISCORD').value).toBe('!discord');
            expect(validateCommandName('  !MiXeD  ').value).toBe('!mixed');
        });

        it('carries the schema own message rather than a rewritten one', () => {
            // These are written for humans already; a translation layer would be
            // one more thing to keep true.
            expect(validateCommandName('nobang').message)
                .toBe('must start with ! and contain no spaces');
        });
    });

    describe('replies', () => {
        for (const raw of REPLY_CASES) {
            it(`agrees with chatTextSchema on a ${raw.length}-character reply`, () => {
                const schema = chatTextSchema.safeParse(raw);
                const ui = validateReply(raw);

                expect(ui.ok).toBe(schema.success);
                if (schema.success) expect(ui.value).toBe(schema.data);
            });
        }
    });

    describe('emote triggers', () => {
        for (const raw of ['KEKW', '  kekw  ', '', 'a'.repeat(64), 'a'.repeat(65), 'two words']) {
            it(`agrees with emoteTriggerSchema on ${JSON.stringify(raw)}`, () => {
                const schema = emoteTriggerSchema.safeParse(raw);
                const ui = validateEmoteTrigger(raw);

                expect(ui.ok).toBe(schema.success);
                if (schema.success) expect(ui.value).toBe(schema.data);
            });
        }

        it('lowercases, because matching is exact and on the lowercased text', () => {
            // A trigger stored as `KEKW` would never fire.
            expect(validateEmoteTrigger('KEKW').value).toBe('kekw');
        });

        it('accepts a trigger with spaces, matching the schema rather than the command rule', () => {
            // Emote triggers are NOT command names: the exact-match model has no
            // reason to forbid a phrase. Asserted so nobody "helpfully" copies
            // the command regex across.
            expect(validateEmoteTrigger('two words').ok).toBe(true);
        });
    });

    describe('quote text', () => {
        for (const raw of ['a quote', '', '   ', 'a'.repeat(1000), 'a'.repeat(1001)]) {
            it(`agrees with createQuoteSchema on a ${raw.length}-character quote`, () => {
                const schema = createQuoteSchema.shape.quoteText.safeParse(raw);
                const ui = validateQuoteText(raw);

                expect(ui.ok).toBe(schema.success);
            });
        }
    });

    describe('the counters', () => {
        it('reads its denominator off the schema, not a literal', () => {
            expect(REPLY_MAX_LENGTH).toBe(chatTextSchema.maxLength);
            expect(QUOTE_MAX_LENGTH).toBe(createQuoteSchema.shape.quoteText.maxLength);
        });

        it('resolved a real limit rather than falling back', () => {
            /*
             * `?? 500` would look identical to a working derivation if the
             * getter ever returned undefined — the counter would read 500
             * forever while the schema said something else. This is the
             * assertion that the fallback is NOT what is in use.
             */
            expect(chatTextSchema.maxLength).not.toBeNull();
            expect(REPLY_MAX_LENGTH).toBe(500);
            expect(QUOTE_MAX_LENGTH).toBe(1000);
        });
    });
});
