import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { computeSignature, verifySignature, isTimestampFresh } from './signature.js';

const SECRET = 'a-secret-that-is-long-enough';

describe('computeSignature', () => {
    it('matches an independently computed HMAC over id + timestamp + body', () => {
        // Computed the long way round, so this test would catch a change to the
        // concatenation order rather than merely agreeing with itself.
        const messageId = 'msg-1';
        const timestamp = '2026-08-15T12:00:00.000Z';
        const rawBody = Buffer.from('{"hello":"world"}', 'utf8');

        const expected = `sha256=${createHmac('sha256', SECRET)
            .update(messageId + timestamp)
            .update(rawBody)
            .digest('hex')}`;

        expect(computeSignature({ secret: SECRET, messageId, timestamp, rawBody })).toBe(expected);
    });

    it('is sensitive to the exact bytes of the body', () => {
        const base = { secret: SECRET, messageId: 'm', timestamp: 't' };

        // Same JSON value, different bytes. This is precisely why the raw body is
        // preserved instead of re-serialised.
        const a = computeSignature({ ...base, rawBody: Buffer.from('{"a":1,"b":2}') });
        const b = computeSignature({ ...base, rawBody: Buffer.from('{"b":2,"a":1}') });

        expect(a).not.toBe(b);
    });
});

describe('verifySignature', () => {
    const input = {
        secret: SECRET,
        messageId: 'msg-1',
        timestamp: '2026-08-15T12:00:00.000Z',
        rawBody: Buffer.from('{"hello":"world"}', 'utf8')
    };

    it('accepts a correct signature', () => {
        expect(verifySignature({ ...input, signature: computeSignature(input) })).toBe(true);
    });

    it('rejects a signature made with a different secret', () => {
        const forged = computeSignature({ ...input, secret: 'some-other-secret-value' });

        expect(verifySignature({ ...input, signature: forged })).toBe(false);
    });

    it('rejects a tampered body', () => {
        const signature = computeSignature(input);

        expect(verifySignature({ ...input, rawBody: Buffer.from('{"hello":"tampered"}'), signature })).toBe(false);
    });

    it('rejects a replayed signature reused under a different message id', () => {
        const signature = computeSignature(input);

        expect(verifySignature({ ...input, messageId: 'msg-2', signature })).toBe(false);
    });

    it('returns false rather than throwing on a wrong-length signature', () => {
        // timingSafeEqual throws on unequal lengths; a wrong-length signature is
        // simply wrong, and must not become a 500.
        expect(verifySignature({ ...input, signature: 'sha256=short' })).toBe(false);
        expect(verifySignature({ ...input, signature: '' })).toBe(false);
    });
});

describe('isTimestampFresh', () => {
    const now = Date.parse('2026-08-15T12:00:00.000Z');
    const tenMinutes = 600_000;

    it('accepts a timestamp inside the window', () => {
        expect(isTimestampFresh('2026-08-15T11:55:00.000Z', tenMinutes, now)).toBe(true);
    });

    it('rejects one older than the window', () => {
        expect(isTimestampFresh('2026-08-15T11:40:00.000Z', tenMinutes, now)).toBe(false);
    });

    it('rejects one from the future by more than the window', () => {
        // A future timestamp is as suspect as an ancient one.
        expect(isTimestampFresh('2026-08-15T12:20:00.000Z', tenMinutes, now)).toBe(false);
    });

    it('rejects an unparseable timestamp', () => {
        expect(isTimestampFresh('not a date', tenMinutes, now)).toBe(false);
        expect(isTimestampFresh('', tenMinutes, now)).toBe(false);
    });
});
