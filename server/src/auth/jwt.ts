import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The app's own session tokens, deliberately unrelated to Twitch's.
 *
 * A Twitch access token is Twitch's credential and has no business being handed
 * to a desktop client. The client gets a token *this* server issued, carrying
 * only what the API needs to authorize a request, and it can be revoked without
 * touching the user's Twitch authorization.
 *
 * HS256 via node's crypto: one signing key, one verifier, no dependency. The
 * asymmetric case (multiple verifying services) does not exist here.
 */

export interface JwtClaims {
    /** Twitch user id of the signed-in person. */
    sub: string;
    login: string;
    /** Issued-at and expiry, seconds since epoch, as the JWT spec requires. */
    iat: number;
    exp: number;
}

export class JwtError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JwtError';
    }
}

const HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

export function signJwt(claims: Omit<JwtClaims, 'iat' | 'exp'>, secret: string, ttlSeconds: number, now = Date.now()): string {
    const issuedAt = Math.floor(now / 1000);
    const payload: JwtClaims = { ...claims, iat: issuedAt, exp: issuedAt + ttlSeconds };

    const body = `${HEADER}.${base64url(JSON.stringify(payload))}`;
    return `${body}.${sign(body, secret)}`;
}

/**
 * @throws {JwtError} for a malformed token, a bad signature, or an expired one,
 * never revealing which claim failed beyond that.
 */
export function verifyJwt(token: string, secret: string, now = Date.now()): JwtClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw new JwtError('malformed token');

    const [header, payload, signature] = parts as [string, string, string];

    // Signature before parsing: the payload is attacker-controlled until proven
    // otherwise, and `alg: none` is only a vulnerability if the header is trusted.
    if (header !== HEADER) throw new JwtError('unsupported token header');

    const expected = sign(`${header}.${payload}`, secret);
    if (!constantTimeEqual(expected, signature)) throw new JwtError('bad signature');

    let claims: JwtClaims;
    try {
        claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
    } catch {
        throw new JwtError('malformed token payload');
    }

    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) {
        throw new JwtError('token expired');
    }
    if (typeof claims.sub !== 'string' || claims.sub === '') {
        throw new JwtError('token has no subject');
    }

    return claims;
}

/**
 * Refresh tokens are opaque random strings, not JWTs.
 *
 * A self-describing refresh token cannot be revoked without a blocklist; an
 * opaque handle is revoked by deleting the row it points at. Only its hash is
 * stored, so a database leak does not yield usable refresh tokens.
 */
export function generateRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
    // Keyless: the stored value is a lookup key, and the token itself is already
    // 256 bits of CSPRNG, so there is nothing to brute-force.
    return createHmac('sha256', 'almosthadai-refresh-token').update(token).digest('base64url');
}

function sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('base64url');
}

function base64url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}
