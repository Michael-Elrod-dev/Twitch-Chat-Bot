import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
    encryptToken,
    decryptToken,
    isEncrypted,
    parseEncryptionKey,
    secretsEqual,
    TokenCryptoError
} from './tokenCrypto.js';
import { createTokenCipher, createDisabledTokenCipher, TOKEN_PURPOSES } from './tokenCipher.js';

/**
 * The threat is a leaked database dump. These tests are written from that angle:
 * what an attacker holding ciphertext, or holding the wrong key, can do with it.
 */

const KEY = randomBytes(32);
const KEY_B64 = KEY.toString('base64');
const PURPOSE = TOKEN_PURPOSES.channelAccess;
const SECRET_VALUE = 'oauth-token-that-must-never-leak';

describe('parseEncryptionKey', () => {
    it('accepts base64 and hex forms of the same key', () => {
        expect(parseEncryptionKey(KEY.toString('base64')).equals(KEY)).toBe(true);
        expect(parseEncryptionKey(KEY.toString('hex')).equals(KEY)).toBe(true);
    });

    it('tolerates surrounding whitespace from a copy-paste', () => {
        expect(parseEncryptionKey(`  ${KEY_B64}\n`).equals(KEY)).toBe(true);
    });

    it('rejects a key that is not 32 bytes rather than padding it', () => {
        // Silently padding would be a quiet downgrade of the whole scheme.
        expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow(TokenCryptoError);
        expect(() => parseEncryptionKey(randomBytes(64).toString('base64'))).toThrow(TokenCryptoError);
        expect(() => parseEncryptionKey('')).toThrow(TokenCryptoError);
    });

    it('never puts the key material in the error message', () => {
        const key = 'a'.repeat(20);
        try {
            parseEncryptionKey(key);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as Error).message).not.toContain(key);
        }
    });
});

describe('encryptToken / decryptToken', () => {
    it('round-trips', () => {
        const encrypted = encryptToken(SECRET_VALUE, KEY, PURPOSE);

        expect(decryptToken(encrypted, KEY, PURPOSE)).toBe(SECRET_VALUE);
    });

    it('never leaves the plaintext visible in the ciphertext', () => {
        const encrypted = encryptToken(SECRET_VALUE, KEY, PURPOSE);

        expect(encrypted).not.toContain(SECRET_VALUE);
        expect(Buffer.from(encrypted.split('.')[3] as string, 'base64').toString('utf8'))
            .not.toContain('oauth');
    });

    it('produces a different ciphertext every time', () => {
        // A deterministic ciphertext would let an attacker holding a dump tell
        // which channels share a token, and spot when one stops changing.
        const first = encryptToken(SECRET_VALUE, KEY, PURPOSE);
        const second = encryptToken(SECRET_VALUE, KEY, PURPOSE);

        expect(first).not.toBe(second);
        expect(decryptToken(second, KEY, PURPOSE)).toBe(SECRET_VALUE);
    });

    it('refuses the wrong key', () => {
        const encrypted = encryptToken(SECRET_VALUE, KEY, PURPOSE);

        expect(() => decryptToken(encrypted, randomBytes(32), PURPOSE)).toThrow(TokenCryptoError);
    });

    it('refuses a value moved to another column', () => {
        // The AAD binding: an access token pasted into the refresh-token column
        // fails loudly rather than being used as a refresh token.
        const encrypted = encryptToken(SECRET_VALUE, KEY, TOKEN_PURPOSES.channelAccess);

        expect(() => decryptToken(encrypted, KEY, TOKEN_PURPOSES.channelRefresh)).toThrow(TokenCryptoError);
    });

    it('detects a tampered ciphertext instead of returning garbage', () => {
        // The reason for GCM over CBC: authentication, not just encryption.
        const encrypted = encryptToken(SECRET_VALUE, KEY, PURPOSE);
        const parts = encrypted.split('.');
        const body = Buffer.from(parts[3] as string, 'base64');
        body[0] = (body[0] as number) ^ 0xff;
        parts[3] = body.toString('base64');

        expect(() => decryptToken(parts.join('.'), KEY, PURPOSE)).toThrow(TokenCryptoError);
    });

    it('detects a tampered auth tag', () => {
        const parts = encryptToken(SECRET_VALUE, KEY, PURPOSE).split('.');
        const tag = Buffer.from(parts[2] as string, 'base64');
        tag[0] = (tag[0] as number) ^ 0xff;
        parts[2] = tag.toString('base64');

        expect(() => decryptToken(parts.join('.'), KEY, PURPOSE)).toThrow(TokenCryptoError);
    });

    it('rejects a malformed envelope without crashing', () => {
        for (const bad of ['', 'not-encrypted', 'v1.only.three', 'v2.a.b.c', 'v1....']) {
            expect(() => decryptToken(bad, KEY, PURPOSE)).toThrow(TokenCryptoError);
        }
    });

    it('never puts the plaintext in a failure message', () => {
        const encrypted = encryptToken(SECRET_VALUE, KEY, PURPOSE);
        try {
            decryptToken(encrypted, randomBytes(32), PURPOSE);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as Error).message).not.toContain(SECRET_VALUE);
        }
    });

    it('handles unicode and empty values', () => {
        for (const value of ['', 'emoji 🎮 token', 'a'.repeat(5000)]) {
            expect(decryptToken(encryptToken(value, KEY, PURPOSE), KEY, PURPOSE)).toBe(value);
        }
    });
});

describe('isEncrypted', () => {
    it('recognises its own output', () => {
        expect(isEncrypted(encryptToken(SECRET_VALUE, KEY, PURPOSE))).toBe(true);
    });

    it('recognises an ETL-imported plaintext token', () => {
        // The upgrade script depends on this distinction being exact.
        expect(isEncrypted('oauth:abcdef1234567890')).toBe(false);
        expect(isEncrypted('')).toBe(false);
        expect(isEncrypted('a.b.c.d')).toBe(false);
    });
});

describe('TokenCipher', () => {
    it('encrypts and decrypts through the configured key', () => {
        const cipher = createTokenCipher(KEY_B64);
        const stored = cipher.encrypt(SECRET_VALUE, TOKEN_PURPOSES.channelRefresh);

        expect(cipher.decrypt(stored, TOKEN_PURPOSES.channelRefresh)).toBe(SECRET_VALUE);
    });

    it('refuses a plaintext value by default', () => {
        // A plaintext row reaching the running server means the upgrade was not
        // run, and reading it silently would leave it plaintext forever.
        const cipher = createTokenCipher(KEY_B64);

        expect(() => cipher.decrypt('plain-token', TOKEN_PURPOSES.channelAccess)).toThrow(TokenCryptoError);
    });

    it('tolerates plaintext only when explicitly asked', () => {
        const cipher = createTokenCipher(KEY_B64);

        expect(cipher.decrypt('plain-token', TOKEN_PURPOSES.channelAccess, true)).toBe('plain-token');
    });

    describe('when no key is configured', () => {
        it('refuses to encrypt rather than storing plaintext', () => {
            // The important half: a keyless server must be unable to store a
            // credential at all, not quietly store it unprotected.
            const cipher = createDisabledTokenCipher();

            expect(() => cipher.encrypt(SECRET_VALUE, TOKEN_PURPOSES.channelAccess)).toThrow(TokenCryptoError);
            expect(() => cipher.decrypt('anything', TOKEN_PURPOSES.channelAccess)).toThrow(TokenCryptoError);
        });
    });
});

describe('secretsEqual', () => {
    it('compares equal and unequal values', () => {
        expect(secretsEqual('abc', 'abc')).toBe(true);
        expect(secretsEqual('abc', 'abd')).toBe(false);
    });

    it('returns false rather than throwing on a length mismatch', () => {
        expect(secretsEqual('short', 'much longer value')).toBe(false);
    });
});
