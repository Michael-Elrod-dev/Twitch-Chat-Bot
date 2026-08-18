import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * At-rest encryption for OAuth tokens.
 *
 * A leaked database dump is the threat being defended against, and the
 * recovered production dump is exactly why that matters. AES-256-GCM rather
 * than CBC because it authenticates as well as encrypts, so a tampered
 * ciphertext fails loudly instead of decrypting to garbage that some caller
 * then sends to Twitch.
 *
 * Nothing in this module ever logs, returns, or embeds a plaintext value in an
 * error message. Every failure says what went wrong and nothing about what was
 * being protected.
 */

/** Version prefix. Present so a future scheme can be introduced without ambiguity. */
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const TAG_BYTES = 16;

export class TokenCryptoError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'TokenCryptoError';
    }
}

/**
 * Parses the configured key.
 *
 * Accepts base64 or hex so an operator can paste whatever their key generator
 * produced, and rejects anything that is not exactly 32 bytes rather than
 * silently padding, because a short key would be a quiet downgrade of the whole
 * scheme.
 *
 * @throws {TokenCryptoError} never including the key material.
 */
export function parseEncryptionKey(configured: string): Buffer {
    const trimmed = configured.trim();

    if (trimmed === '') {
        throw new TokenCryptoError('TOKEN_ENCRYPTION_KEY is empty');
    }

    const candidates: Buffer[] = [];
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2) {
        candidates.push(Buffer.from(trimmed, 'hex'));
    }
    candidates.push(Buffer.from(trimmed, 'base64'));

    const key = candidates.find((candidate) => candidate.length === KEY_BYTES);
    if (!key) {
        throw new TokenCryptoError(
            `TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (base64 or hex)`
        );
    }

    return key;
}

/**
 * @param purpose bound into the ciphertext as additional authenticated data, so
 * a value cannot be moved between columns. An access token pasted into the
 * refresh-token column fails to decrypt rather than being used as a refresh
 * token. That is cheap, and it turns a class of mistakes into a loud error.
 */
export function encryptToken(plaintext: string, key: Buffer, purpose: string): string {
    if (key.length !== KEY_BYTES) {
        throw new TokenCryptoError('encryption key is the wrong size');
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(purpose, 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/** @throws {TokenCryptoError} on a wrong key, a wrong purpose, or any tampering. */
export function decryptToken(payload: string, key: Buffer, purpose: string): string {
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new TokenCryptoError('stored token is not in the expected encrypted format');
    }

    const [, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string];

    const iv = Buffer.from(ivPart, 'base64');
    const tag = Buffer.from(tagPart, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new TokenCryptoError('stored token has a malformed envelope');
    }

    try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAAD(Buffer.from(purpose, 'utf8'));
        decipher.setAuthTag(tag);

        return Buffer.concat([
            decipher.update(Buffer.from(ciphertextPart, 'base64')),
            decipher.final()
        ]).toString('utf8');
    } catch (err) {
        // Deliberately does not carry the underlying message through: OpenSSL's
        // text is unhelpful and the context here is already complete.
        throw new TokenCryptoError('could not decrypt stored token (wrong key, wrong purpose, or tampering)', {
            cause: err instanceof Error ? new Error(err.name) : undefined
        });
    }
}

/**
 * Whether a stored value is already encrypted.
 *
 * The upgrade script and the read path both need to tell an imported plaintext
 * row from an encrypted one. It checks structure only, so a plaintext token that
 * happened to contain dots is still correctly identified by its version prefix.
 */
export function isEncrypted(value: string): boolean {
    const parts = value.split('.');
    return parts.length === 4 && parts[0] === VERSION;
}

/**
 * Constant-time equality for secrets that are compared rather than decrypted
 * (OAuth state, refresh-token handles).
 */
export function secretsEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}
