import { ne } from 'drizzle-orm';
import type { Database } from '../client.js';
import { botIdentity } from '../schema/channels.js';
import { TOKEN_PURPOSES, type TokenCipher } from '../../crypto/tokenCipher.js';

export interface BotIdentityRecord {
    twitchUserId: string;
    twitchLogin: string;
    grantedScopes: string[];
}

export interface BotIdentityUpsert extends BotIdentityRecord {
    /**
     * Kept so consent can be re-established without a manual re-auth. It is NOT
     * on any request path — every Helix call the bot makes runs on an *app*
     * token (the P1-WP3 enumeration), which is why this table is a consent
     * record rather than a rotating token pair.
     */
    refreshToken: string | null;
}

/**
 * The shared bot account.
 *
 * One row by design (owner decision §8.5): a single identity reads and writes in
 * every channel, which is Twitch's own documented pattern for this architecture.
 * Not channel-scoped, because it is not per-channel data.
 */
export class BotIdentityRepository {
    private readonly db: Database;
    private readonly cipher: TokenCipher | undefined;

    constructor(db: Database, cipher?: TokenCipher) {
        this.db = db;
        this.cipher = cipher;
    }

    async get(): Promise<BotIdentityRecord | null> {
        const rows = await this.db
            .select({
                twitchUserId: botIdentity.twitchUserId,
                twitchLogin: botIdentity.twitchLogin,
                grantedScopes: botIdentity.grantedScopes
            })
            .from(botIdentity)
            .limit(1);

        return rows[0] ?? null;
    }

    /** @returns the decrypted refresh token, or null when consent recorded none. */
    async getRefreshToken(tolerateLegacyPlaintext = false): Promise<string | null> {
        if (!this.cipher) throw new Error('BotIdentityRepository was constructed without a cipher');

        const [row] = await this.db
            .select({ refreshToken: botIdentity.refreshToken })
            .from(botIdentity)
            .limit(1);

        if (!row?.refreshToken) return null;
        return this.cipher.decrypt(row.refreshToken, TOKEN_PURPOSES.botRefresh, tolerateLegacyPlaintext);
    }

    async upsert(identity: BotIdentityUpsert): Promise<void> {
        if (!this.cipher) throw new Error('BotIdentityRepository was constructed without a cipher');

        const encrypted = identity.refreshToken === null
            ? null
            : this.cipher.encrypt(identity.refreshToken, TOKEN_PURPOSES.botRefresh);

        await this.db
            .insert(botIdentity)
            .values({
                twitchUserId: identity.twitchUserId,
                twitchLogin: identity.twitchLogin,
                grantedScopes: identity.grantedScopes,
                refreshToken: encrypted
            })
            .onConflictDoUpdate({
                target: botIdentity.twitchUserId,
                set: {
                    twitchLogin: identity.twitchLogin,
                    grantedScopes: identity.grantedScopes,
                    refreshToken: encrypted,
                    authorizedAt: new Date(),
                    updatedAt: new Date()
                }
            });
    }

    /**
     * Replaces any existing identity with this one.
     *
     * The bot account is singular, so a *different* account authorizing means the
     * bot changed - leaving the old row would give `resolveBotIdentity` two rows
     * and an arbitrary winner.
     */
    async replaceWith(identity: BotIdentityUpsert): Promise<void> {
        await this.db.delete(botIdentity).where(ne(botIdentity.twitchUserId, identity.twitchUserId));
        await this.upsert(identity);
    }
}
