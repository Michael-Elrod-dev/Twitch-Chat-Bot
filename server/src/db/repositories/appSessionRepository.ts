import { and, eq, isNull, gt } from 'drizzle-orm';
import type { Database } from '../client.js';
import { appRefreshTokens } from '../schema/channels.js';
import { hashRefreshToken } from '../../auth/jwt.js';

export interface AppSession {
    twitchUserId: string;
    login: string;
}

const REFRESH_TTL_DAYS = 30;

/**
 * Sessions for the app's own sign-in.
 *
 * Only hashes are stored and only hashes are queried, so no method here ever
 * holds a usable refresh token longer than the call that was handed one.
 */
export class AppSessionRepository {
    private readonly db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    async create(token: string, session: AppSession, now = new Date()): Promise<void> {
        await this.db.insert(appRefreshTokens).values({
            tokenHash: hashRefreshToken(token),
            twitchUserId: session.twitchUserId,
            login: session.login,
            expiresAt: new Date(now.getTime() + REFRESH_TTL_DAYS * 24 * 60 * 60_000)
        });
    }

    /** @returns the session, or null when the token is unknown, revoked or expired. */
    async resolve(token: string, now = new Date()): Promise<AppSession | null> {
        const [row] = await this.db
            .select({ twitchUserId: appRefreshTokens.twitchUserId, login: appRefreshTokens.login })
            .from(appRefreshTokens)
            .where(
                and(
                    eq(appRefreshTokens.tokenHash, hashRefreshToken(token)),
                    isNull(appRefreshTokens.revokedAt),
                    gt(appRefreshTokens.expiresAt, now)
                )
            );

        return row ?? null;
    }

    /** Revocation is a delete: there is nothing worth keeping about a dead session. */
    async revoke(token: string): Promise<boolean> {
        const removed = await this.db
            .delete(appRefreshTokens)
            .where(eq(appRefreshTokens.tokenHash, hashRefreshToken(token)))
            .returning({ id: appRefreshTokens.id });

        return removed.length > 0;
    }

    async revokeAllFor(twitchUserId: string): Promise<number> {
        const removed = await this.db
            .delete(appRefreshTokens)
            .where(eq(appRefreshTokens.twitchUserId, twitchUserId))
            .returning({ id: appRefreshTokens.id });

        return removed.length;
    }
}
