import { describe, it, expect } from 'vitest';
import { generateNonce, parseAuthCallback, returnToWithNonce } from './deepLink.js';

/**
 * The deep link is the one place a hostile input reaches this app directly:
 * any local program can invoke a registered URI scheme. So the parser is
 * tested the way the server's `return_to` allow-list is — by trying the shapes
 * an attacker would.
 */

const TOKENS = 'access_token=at-value&refresh_token=rt-value';

describe('parseAuthCallback', () => {
    it('reads both tokens and the nonce', () => {
        const result = parseAuthCallback(`almosthadai://auth?n=abc123#${TOKENS}`);

        expect(result).toEqual({
            accessToken: 'at-value',
            refreshToken: 'rt-value',
            nonce: 'abc123'
        });
    });

    it('reads a callback with no nonce as having none, rather than failing', () => {
        // The caller decides what to do about it; the parser only reports.
        expect(parseAuthCallback(`almosthadai://auth#${TOKENS}`)?.nonce).toBeNull();
    });

    it.each([
        ['a different scheme', `https://evil.example/auth#${TOKENS}`],
        ['a scheme that merely starts the same', `almosthadai-evil://auth#${TOKENS}`],
        ['no fragment at all', 'almosthadai://auth?n=abc'],
        ['tokens in the query instead of the fragment', 'almosthadai://auth?access_token=a&refresh_token=b'],
        ['only an access token', 'almosthadai://auth#access_token=at-value'],
        ['only a refresh token', 'almosthadai://auth#refresh_token=rt-value'],
        ['not a URL', 'not a url at all'],
        ['empty', '']
    ])('refuses %s', (_label, url) => {
        expect(parseAuthCallback(url)).toBeNull();
    });

    it('does not confuse a query parameter for a fragment one', () => {
        // `?access_token=…#refresh_token=…` has one of each; half a session is
        // not a session.
        expect(parseAuthCallback('almosthadai://auth?access_token=a#refresh_token=b')).toBeNull();
    });
});

describe('returnToWithNonce', () => {
    it('keeps the scheme the server allow-lists, and rides the nonce in the query', () => {
        const value = returnToWithNonce('abc123');

        expect(value).toBe('almosthadai://auth?n=abc123');
        // The server appends `#access_token=…` to whatever this is, so it must
        // not already carry a fragment.
        expect(value).not.toContain('#');
    });

    it('round-trips through the callback the server would produce', () => {
        const nonce = generateNonce();
        const returnTo = returnToWithNonce(nonce);

        const parsed = parseAuthCallback(`${returnTo}#${TOKENS}`);
        expect(parsed?.nonce).toBe(nonce);
    });

    it('escapes a nonce so it cannot inject another parameter', () => {
        expect(returnToWithNonce('a&access_token=stolen')).toBe(
            'almosthadai://auth?n=a%26access_token%3Dstolen'
        );
    });
});

describe('generateNonce', () => {
    it('produces a long random hex string', () => {
        expect(generateNonce()).toMatch(/^[0-9a-f]{32}$/);
    });

    it('does not repeat', () => {
        const seen = new Set(Array.from({ length: 50 }, () => generateNonce()));
        expect(seen.size).toBe(50);
    });
});
