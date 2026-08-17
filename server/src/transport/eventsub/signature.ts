import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twitch signs each delivery with HMAC-SHA256 over
 * `message-id + message-timestamp + raw body`, keyed by the subscription secret
 * (docs/TWITCH_PLATFORM_FACTS.md section 3).
 *
 * Two details are load-bearing and easy to get wrong:
 *  - the *raw* body must be hashed, not a re-serialised parse, because JSON key
 *    order and whitespace are not preserved by a round-trip;
 *  - the comparison must be timing-safe, or the endpoint leaks the correct
 *    signature one byte at a time to anyone willing to measure.
 */

export interface SignatureInput {
    secret: string;
    messageId: string;
    timestamp: string;
    rawBody: Buffer;
}

export function computeSignature({ secret, messageId, timestamp, rawBody }: SignatureInput): string {
    const hmac = createHmac('sha256', secret);
    hmac.update(messageId);
    hmac.update(timestamp);
    hmac.update(rawBody);
    return `sha256=${hmac.digest('hex')}`;
}

/** @returns whether `signature` matches, without leaking where it stopped matching. */
export function verifySignature(input: SignatureInput & { signature: string }): boolean {
    const expected = Buffer.from(computeSignature(input), 'utf8');
    const actual = Buffer.from(input.signature, 'utf8');

    // timingSafeEqual throws on a length mismatch, which would itself be a
    // timing signal; a wrong-length signature is simply wrong.
    if (expected.length !== actual.length) return false;

    return timingSafeEqual(expected, actual);
}

/**
 * Replay guard.
 *
 * Twitch's documented window is 10 minutes, and widening it is not laziness: a
 * retried delivery repeats the *original* timestamp, so a tight window rejects
 * precisely the redeliveries the retry policy exists to make. Dedup on the
 * message id — not a narrow clock window — is what stops a replayed event being
 * processed twice.
 *
 * @returns false when the timestamp is unparseable or outside the window in
 * either direction (a future timestamp is as suspect as an ancient one).
 */
export function isTimestampFresh(timestamp: string, maxSkewMs: number, now: number = Date.now()): boolean {
    const sent = Date.parse(timestamp);
    if (Number.isNaN(sent)) return false;

    return Math.abs(now - sent) <= maxSkewMs;
}
