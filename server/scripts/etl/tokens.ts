import type postgres from 'postgres';

/**
 * Credential handling for the dump import.
 *
 * Extracted from the ETL body so the rule that matters can be tested directly:
 * **a live authorization always beats a value from the dump.** The dump is a
 * point-in-time snapshot whose tokens were dead within hours of being taken;
 * anything a broadcaster has granted since is both newer and encrypted, and
 * overwriting it would disconnect a working channel to install a token that
 * cannot work.
 *
 * No function here logs, returns, or embeds a token value.
 */

export type TokenProvider = 'twitch' | 'spotify';

export interface TokenImportOutcome {
    provider: TokenProvider;
    action: 'preserved' | 'imported' | 'absent';
}

export interface DumpTokenSource {
    accessToken: string | undefined;
    refreshToken: string | undefined;
}

/**
 * @returns what happened, so the caller can report counts without inspecting
 * the database again.
 */
export async function importChannelTokens(
    sql: postgres.Sql,
    channelId: string,
    source: (provider: TokenProvider) => DumpTokenSource
): Promise<TokenImportOutcome[]> {
    const outcomes: TokenImportOutcome[] = [];

    for (const provider of ['twitch', 'spotify'] as const) {
        const [existing] = await sql<{ n: number }[]>`
            select count(*)::int as n from channel_tokens
            where channel_id = ${channelId} and provider = ${provider}
        `;

        // Skip-if-present, unconditionally. There is no version of "the dump is
        // newer" that can be true here.
        if ((existing?.n ?? 0) > 0) {
            outcomes.push({ provider, action: 'preserved' });
            continue;
        }

        const { accessToken, refreshToken } = source(provider);
        if (!accessToken || !refreshToken) {
            outcomes.push({ provider, action: 'absent' });
            continue;
        }

        await sql`
            insert into channel_tokens (channel_id, provider, access_token, refresh_token, scopes)
            values (${channelId}, ${provider}, ${accessToken}, ${refreshToken}, ${JSON.stringify([])}::jsonb)
        `;
        outcomes.push({ provider, action: 'imported' });
    }

    return outcomes;
}

export interface BotIdentitySource {
    twitchUserId: string;
    login: string;
    refreshToken: string | null;
}

/**
 * Same rule, plus one of its own: the dump records no scopes at all, so the
 * list an import would write is inferred rather than stated. A real consent
 * record knows exactly what was granted.
 */
export async function importBotIdentity(
    sql: postgres.Sql,
    source: BotIdentitySource
): Promise<'preserved' | 'imported'> {
    const [existing] = await sql<{ n: number }[]>`select count(*)::int as n from bot_identity`;

    if ((existing?.n ?? 0) > 0) {
        return 'preserved';
    }

    await sql`
        insert into bot_identity (twitch_user_id, twitch_login, granted_scopes, refresh_token)
        values (${source.twitchUserId}, ${source.login},
                ${JSON.stringify(['user:read:chat', 'user:write:chat', 'user:bot'])}::jsonb,
                ${source.refreshToken})
        on conflict (twitch_user_id) do update
            set refresh_token = excluded.refresh_token, updated_at = now()
    `;

    return 'imported';
}
