import { encryptToken, decryptToken, isEncrypted, parseEncryptionKey, TokenCryptoError } from './tokenCrypto.js';

/**
 * The configured cipher, as one object the data layer can hold.
 *
 * Purposes are named here rather than spelled at call sites, because the AAD
 * binding only works if every writer and reader agrees on the exact string.
 */
export const TOKEN_PURPOSES = {
    channelAccess: 'channel_tokens.access_token',
    channelRefresh: 'channel_tokens.refresh_token',
    botRefresh: 'bot_identity.refresh_token'
} as const;

export type TokenPurpose = (typeof TOKEN_PURPOSES)[keyof typeof TOKEN_PURPOSES];

export interface TokenCipher {
    encrypt: (plaintext: string, purpose: TokenPurpose) => string;
    /**
     * @param toleratePlaintext accepts an unencrypted value and returns it
     * as-is. Set only where a not-yet-upgraded ETL row is genuinely expected —
     * the upgrade script and the read path during migration — so that everywhere
     * else, a plaintext value is an error rather than a silent downgrade.
     */
    decrypt: (stored: string, purpose: TokenPurpose, toleratePlaintext?: boolean) => string;
}

export function createTokenCipher(configuredKey: string): TokenCipher {
    const key = parseEncryptionKey(configuredKey);

    return {
        encrypt: (plaintext, purpose) => encryptToken(plaintext, key, purpose),
        decrypt: (stored, purpose, toleratePlaintext = false) => {
            if (!isEncrypted(stored)) {
                if (toleratePlaintext) return stored;
                throw new TokenCryptoError(
                    `stored value for ${purpose} is not encrypted (run the token upgrade script)`
                );
            }
            return decryptToken(stored, key, purpose);
        }
    };
}

/**
 * Stands in when no key is configured.
 *
 * It refuses every operation rather than passing values through: a development
 * server without a key should be unable to *store* a credential at all, which is
 * a far better failure than quietly writing one in plaintext.
 */
export function createDisabledTokenCipher(): TokenCipher {
    const refuse = (): never => {
        throw new TokenCryptoError('TOKEN_ENCRYPTION_KEY is not configured, so tokens cannot be read or written');
    };

    return { encrypt: refuse, decrypt: refuse };
}
