import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signJwt, verifyJwt, generateRefreshToken, hashRefreshToken, JwtError } from './jwt.js';

const SECRET = 'a-signing-secret-long-enough-to-be-real';
const CLAIMS = { sub: '12345', login: 'someone' };

describe('signJwt / verifyJwt', () => {
    it('round-trips the claims', () => {
        const token = signJwt(CLAIMS, SECRET, 900);

        expect(verifyJwt(token, SECRET)).toMatchObject(CLAIMS);
    });

    it('stamps issued-at and expiry in seconds', () => {
        const now = 1_700_000_000_000;
        const claims = verifyJwt(signJwt(CLAIMS, SECRET, 900, now), SECRET, now);

        expect(claims.iat).toBe(1_700_000_000);
        expect(claims.exp).toBe(1_700_000_900);
    });

    it('rejects a token signed with another secret', () => {
        const forged = signJwt(CLAIMS, 'a-different-secret-entirely-here', 900);

        expect(() => verifyJwt(forged, SECRET)).toThrow(JwtError);
    });

    it('rejects a tampered payload', () => {
        // The whole point of the signature: claims are attacker-controlled until
        // proven otherwise, and elevating `sub` is the obvious attack.
        const token = signJwt(CLAIMS, SECRET, 900);
        const [header, , signature] = token.split('.') as [string, string, string];
        const forgedPayload = Buffer.from(
            JSON.stringify({ sub: 'someone-else', login: 'attacker', iat: 1, exp: 9_999_999_999 })
        ).toString('base64url');

        expect(() => verifyJwt(`${header}.${forgedPayload}.${signature}`, SECRET)).toThrow(JwtError);
    });

    it('rejects an alg:none token', () => {
        // Classic JWT failure: trusting the header's algorithm claim. The header
        // is fixed and compared, so an unsigned token cannot be presented.
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ ...CLAIMS, iat: 1, exp: 9_999_999_999 })).toString('base64url');

        expect(() => verifyJwt(`${header}.${payload}.`, SECRET)).toThrow(JwtError);
    });

    it('rejects an expired token', () => {
        const issuedAt = 1_700_000_000_000;
        const token = signJwt(CLAIMS, SECRET, 60, issuedAt);

        expect(() => verifyJwt(token, SECRET, issuedAt + 61_000)).toThrow(/expired/);
        expect(verifyJwt(token, SECRET, issuedAt + 59_000)).toMatchObject(CLAIMS);
    });

    it('rejects malformed input without crashing', () => {
        for (const bad of ['', 'not.a.token', 'a.b', 'a.b.c.d']) {
            expect(() => verifyJwt(bad, SECRET)).toThrow(JwtError);
        }
    });

    it('rejects a token with no subject', () => {
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ login: 'x', iat: 1, exp: 9_999_999_999 })).toString('base64url');
        const body = `${header}.${payload}`;
        const signature = createHmac('sha256', SECRET).update(body).digest('base64url');

        expect(() => verifyJwt(`${body}.${signature}`, SECRET)).toThrow(JwtError);
    });
});

describe('refresh tokens', () => {
    it('issues a token alongside the hash that gets stored', () => {
        const { token, hash } = generateRefreshToken();

        expect(token.length).toBeGreaterThan(30);
        expect(hash).toBe(hashRefreshToken(token));
    });

    it('never stores the token itself', () => {
        // A database leak must not yield usable refresh tokens.
        const { token, hash } = generateRefreshToken();

        expect(hash).not.toBe(token);
        expect(hash).not.toContain(token);
    });

    it('produces a distinct token every time', () => {
        const tokens = new Set(Array.from({ length: 50 }, () => generateRefreshToken().token));

        expect(tokens.size).toBe(50);
    });

    it('hashes deterministically, so lookup by hash works', () => {
        const { token } = generateRefreshToken();

        expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    });
});
