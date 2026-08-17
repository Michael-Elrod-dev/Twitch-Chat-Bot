import { and, eq } from 'drizzle-orm';
import { channelTokens } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';
import type { Database } from '../client.js';
import { TOKEN_PURPOSES, type TokenCipher } from '../../crypto/tokenCipher.js';

export type TokenProvider = 'twitch' | 'spotify';

export interface StoredTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date | null;
    scopes: string[];
}

export interface TokenUpsert {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date | null;
    scopes: string[];
}

/**
 * Encrypted credential storage for one channel.
 *
 * Encryption happens here and nowhere else, so there is exactly one place that
 * could ever write a plaintext token — and it cannot, because the cipher refuses
 * when no key is configured.
 *
 * No method returns, logs, or embeds a token value in an error.
 */
export class ChannelTokenRepository extends ChannelScopedRepository {
    private readonly cipher: TokenCipher;

    constructor(db: Database, channelId: string, cipher: TokenCipher) {
        super(db, channelId);
        this.cipher = cipher;
    }

    /**
     * @param tolerateLegacyPlaintext accepts ETL-imported rows that predate
     * encryption. The upgrade script sets it; the running server does not.
     */
    async get(provider: TokenProvider, tolerateLegacyPlaintext = false): Promise<StoredTokens | null> {
        const [row] = await this.db
            .select({
                accessToken: channelTokens.accessToken,
                refreshToken: channelTokens.refreshToken,
                expiresAt: channelTokens.expiresAt,
                scopes: channelTokens.scopes
            })
            .from(channelTokens)
            .where(and(eq(channelTokens.channelId, this.channelId), eq(channelTokens.provider, provider)));

        if (!row) return null;

        return {
            accessToken: this.cipher.decrypt(row.accessToken, TOKEN_PURPOSES.channelAccess, tolerateLegacyPlaintext),
            refreshToken: this.cipher.decrypt(row.refreshToken, TOKEN_PURPOSES.channelRefresh, tolerateLegacyPlaintext),
            expiresAt: row.expiresAt,
            scopes: row.scopes
        };
    }

    /**
     * Writes a token pair.
     *
     * Both halves move in one statement. Twitch issues a *new* refresh token on
     * every refresh, so a crash between two separate writes could strand the
     * channel holding a refresh token Twitch has already retired — the Phase-0
     * failure that motivated the transactional rotation being ported here.
     */
    async upsert(provider: TokenProvider, tokens: TokenUpsert): Promise<void> {
        const values = {
            channelId: this.channelId,
            provider,
            accessToken: this.cipher.encrypt(tokens.accessToken, TOKEN_PURPOSES.channelAccess),
            refreshToken: this.cipher.encrypt(tokens.refreshToken, TOKEN_PURPOSES.channelRefresh),
            expiresAt: tokens.expiresAt,
            scopes: tokens.scopes
        };

        await this.db
            .insert(channelTokens)
            .values(values)
            .onConflictDoUpdate({
                target: [channelTokens.channelId, channelTokens.provider],
                set: {
                    accessToken: values.accessToken,
                    refreshToken: values.refreshToken,
                    expiresAt: values.expiresAt,
                    scopes: values.scopes,
                    updatedAt: new Date()
                }
            });
    }

    /**
     * @returns whether this channel has credentials for a provider at all.
     *
     * Deliberately never touches the cipher. The dashboard only needs to know
     * that Spotify is linked, and answering that by decrypting a token would
     * put a plaintext credential in memory to compute a boolean — and would
     * make the tile report "not connected" for a row this build cannot decrypt,
     * which is a different and more alarming fact than the one being asked.
     */
    async has(provider: TokenProvider): Promise<boolean> {
        const [row] = await this.db
            .select({ id: channelTokens.id })
            .from(channelTokens)
            .where(and(eq(channelTokens.channelId, this.channelId), eq(channelTokens.provider, provider)))
            .limit(1);

        return row !== undefined;
    }

    async delete(provider: TokenProvider): Promise<boolean> {
        const removed = await this.db
            .delete(channelTokens)
            .where(and(eq(channelTokens.channelId, this.channelId), eq(channelTokens.provider, provider)))
            .returning({ id: channelTokens.id });

        return removed.length > 0;
    }
}
