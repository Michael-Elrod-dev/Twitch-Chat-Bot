/**
 * Imports the Phase-0 single-channel MySQL database into schema v2 as channel #1.
 *
 * SECRECY: the legacy `tokens` table holds live credentials. This script moves
 * them opaquely — no token value is ever logged, printed, or included in the
 * summary. The report is counts only.
 *
 * IDEMPOTENT: re-running deletes the channel's v2 CONTENT rows and re-imports.
 * The channel row is matched on twitch_broadcaster_id, so the channel id is
 * stable across runs.
 *
 * CREDENTIALS ARE NEVER OVERWRITTEN: channel_tokens and bot_identity are
 * skip-if-present. The dump's tokens died months ago; anything granted since is
 * both newer and encrypted, and replacing it would disconnect a working channel
 * to install a token that cannot work. See ./tokens.ts.
 *
 * Usage (see run-import.sh, which supplies the throwaway MySQL):
 *   MYSQL_URL=... DATABASE_URL=... tsx server/scripts/etl/import-legacy.ts
 */

import mysql from 'mysql2/promise';
import postgres from 'postgres';
import { routeTokenKey, splitViewer, resolveRequester, assignQuoteNumbers } from './transform.js';
import { importChannelTokens, importBotIdentity } from './tokens.js';
import type { LegacyViewer } from './transform.js';

const MYSQL_URL = process.env['MYSQL_URL'];
const DATABASE_URL = process.env['DATABASE_URL'];

if (!MYSQL_URL || !DATABASE_URL) {
    console.error('MYSQL_URL and DATABASE_URL are both required');
    process.exit(78);
}

type Counts = Record<string, number>;

const counts: Counts = {};
const bump = (key: string, n = 1): void => {
    counts[key] = (counts[key] ?? 0) + n;
};

async function main(): Promise<void> {
    const my = await mysql.createConnection(MYSQL_URL as string);
    const sql = postgres(DATABASE_URL as string, { max: 4 });

    try {
        // ---- tokens: route the key/value drawer -----------------------------
        const [tokenRows] = await my.query<mysql.RowDataPacket[]>('SELECT token_key, token_value FROM tokens');

        const tokens = new Map<string, string>();
        for (const row of tokenRows) {
            tokens.set(String(row['token_key']), String(row['token_value'] ?? ''));
        }

        const broadcasterId = tokens.get('channelId')?.trim();
        if (!broadcasterId) {
            throw new Error('legacy tokens table has no channelId; cannot identify the channel');
        }

        // Count destinations without revealing anything about the values.
        for (const key of tokens.keys()) {
            bump(`tokens.routed.${routeTokenKey(key).kind}`);
        }

        // ---- channel (idempotent on twitch_broadcaster_id) ------------------
        const [channel] = await sql<{ id: string }[]>`
            insert into channels (twitch_broadcaster_id, twitch_login, display_name, status)
            values (${broadcasterId}, ${'aimosthadme'}, ${'aimosthadme'}, 'active')
            on conflict (twitch_broadcaster_id) do update
                set updated_at = now()
            returning id
        `;
        const channelId = channel!.id;
        bump('channels', 1);

        // Clear this channel's previously-imported CONTENT so a re-run is a clean
        // re-import rather than a duplicate one. Order respects FK dependencies.
        //
        // `channel_tokens` is deliberately absent from this list. The dump is a
        // point-in-time snapshot whose credentials are long dead; a live
        // authorization obtained since is always the better one, and deleting it
        // to make room for a stale token would disconnect a working channel.
        await sql`delete from api_usage where channel_id = ${channelId}`;
        await sql`delete from chat_messages where channel_id = ${channelId}`;
        await sql`delete from chat_totals where channel_id = ${channelId}`;
        await sql`delete from viewing_sessions where channel_id = ${channelId}`;
        await sql`delete from song_queue where channel_id = ${channelId}`;
        await sql`delete from quotes where channel_id = ${channelId}`;
        await sql`delete from commands where channel_id = ${channelId}`;
        await sql`delete from emotes where channel_id = ${channelId}`;
        await sql`delete from channel_roles where channel_id = ${channelId}`;
        await sql`delete from streams where channel_id = ${channelId}`;

        // ---- channel_tokens: import ONLY where nothing live exists -----------
        const tokenOutcomes = await importChannelTokens(sql, channelId, (provider) => ({
            accessToken: provider === 'twitch'
                ? tokens.get('broadcasterAccessToken')
                : tokens.get('spotifyUserAccessToken'),
            refreshToken: provider === 'twitch'
                ? tokens.get('broadcasterRefreshToken')
                : tokens.get('spotifyUserRefreshToken')
        }));

        for (const { provider, action } of tokenOutcomes) {
            bump(`channel_tokens.${action}.${provider}`);
            if (action === 'preserved') {
                console.log(`  channel_tokens/${provider}: live credentials present - dump value NOT imported`);
            } else if (action === 'imported') {
                // Imported values are plaintext by construction; the encrypted
                // read path refuses them until the upgrade script has run.
                console.log(`  channel_tokens/${provider}: imported as PLAINTEXT - run db:encrypt-tokens`);
            }
        }

        // ---- channel_settings ------------------------------------------------
        const aiEnabled = tokens.get('aiEnabled');
        await sql`
            insert into channel_settings (channel_id, ai_enabled)
            values (${channelId}, ${aiEnabled === undefined ? true : aiEnabled === 'true'})
            on conflict (channel_id) do update set ai_enabled = excluded.ai_enabled, updated_at = now()
        `;
        bump('channel_settings');

        // ---- bot_identity ----------------------------------------------------
        const botId = tokens.get('botId');
        if (botId) {
            const outcome = await importBotIdentity(sql, {
                twitchUserId: botId,
                login: 'almosthadai',
                refreshToken: tokens.get('botRefreshToken') ?? null
            });

            bump(`bot_identity.${outcome}`);
            if (outcome === 'preserved') {
                console.log('  bot_identity: live consent present - dump value NOT imported');
            }
        }

        // ---- viewers + channel_roles ----------------------------------------
        const [viewerRows] = await my.query<mysql.RowDataPacket[]>(
            'SELECT user_id, username, is_moderator, is_vip, is_subscriber, is_broadcaster, followed_at, last_seen FROM viewers'
        );

        const loginToId = new Map<string, string>();
        const idSeen = new Set<string>();

        for (const raw of viewerRows) {
            const split = splitViewer(raw as unknown as LegacyViewer);
            if (!split) {
                bump('viewers.skipped_non_numeric_id');
                continue;
            }

            const { identity, role } = split;
            loginToId.set(identity.login.toLowerCase(), identity.twitchUserId);
            idSeen.add(identity.twitchUserId);

            await sql`
                insert into viewers (twitch_user_id, login)
                values (${identity.twitchUserId}, ${identity.login})
                on conflict (twitch_user_id) do update set login = excluded.login, updated_at = now()
            `;
            bump('viewers');

            await sql`
                insert into channel_roles (channel_id, twitch_user_id, is_moderator, is_vip, is_subscriber, is_broadcaster, followed_at, last_seen_at)
                values (${channelId}, ${role.twitchUserId}, ${role.isModerator}, ${role.isVip},
                        ${role.isSubscriber}, ${role.isBroadcaster}, ${role.followedAt}, ${role.lastSeenAt})
                on conflict (channel_id, twitch_user_id) do update
                    set is_moderator = excluded.is_moderator, is_vip = excluded.is_vip,
                        is_subscriber = excluded.is_subscriber, is_broadcaster = excluded.is_broadcaster,
                        followed_at = excluded.followed_at, last_seen_at = excluded.last_seen_at
            `;
            bump('channel_roles');
        }

        // ---- streams ----------------------------------------------------------
        const [streamRows] = await my.query<mysql.RowDataPacket[]>(
            'SELECT stream_id, start_time, end_time, title, category, peak_viewers, total_messages, unique_chatters FROM streams'
        );

        const legacyStreamToUuid = new Map<string, string>();
        for (const row of streamRows) {
            const legacyId = String(row['stream_id']);
            const [inserted] = await sql<{ id: string }[]>`
                insert into streams (channel_id, twitch_stream_id, started_at, ended_at, title, category,
                                     peak_viewers, total_messages, unique_chatters)
                values (${channelId}, ${legacyId}, ${row['start_time']}, ${row['end_time']},
                        ${row['title']}, ${row['category']}, ${row['peak_viewers'] ?? 0},
                        ${row['total_messages'] ?? 0}, ${row['unique_chatters'] ?? 0})
                returning id
            `;
            legacyStreamToUuid.set(legacyId, inserted!.id);
            bump('streams');
        }

        // ---- commands / emotes -------------------------------------------------
        const [commandRows] = await my.query<mysql.RowDataPacket[]>(
            'SELECT command_name, response_text, handler_name, user_level FROM commands'
        );
        for (const row of commandRows) {
            await sql`
                insert into commands (channel_id, name, response_text, handler_name, user_level)
                values (${channelId}, ${String(row['command_name'])}, ${row['response_text']},
                        ${row['handler_name']}, ${String(row['user_level'] ?? 'everyone')})
            `;
            bump('commands');
        }

        const [emoteRows] = await my.query<mysql.RowDataPacket[]>(
            'SELECT trigger_text, response_text FROM emotes'
        );
        for (const row of emoteRows) {
            await sql`
                insert into emotes (channel_id, trigger_text, response_text)
                values (${channelId}, ${String(row['trigger_text'])}, ${String(row['response_text'])})
            `;
            bump('emotes');
        }

        // ---- quotes -------------------------------------------------------------
        const [quoteRows] = await my.query<mysql.RowDataPacket[]>(
            'SELECT quote_id, user_id, quote_text, author, saved_by FROM quotes'
        );
        for (const row of assignQuoteNumbers(quoteRows as unknown as { quote_id: number }[]) as unknown as Array<
            Record<string, unknown> & { quoteNumber: number }
        >) {
            const savedBy = String(row['user_id'] ?? '');
            await sql`
                insert into quotes (channel_id, quote_number, quote_text, author, saved_by_twitch_user_id)
                values (${channelId}, ${row.quoteNumber}, ${String(row['quote_text'] ?? '')},
                        ${row['author'] as string | null}, ${idSeen.has(savedBy) ? savedBy : null})
            `;
            bump('quotes');
        }

        // ---- song_queue ----------------------------------------------------------
        const [songRows] = await my.query<mysql.RowDataPacket[]>(
            'SELECT track_uri, track_name, artist_name, requested_by, queue_position, added_at FROM song_queue'
        );
        for (const row of songRows) {
            const requester = resolveRequester(row['requested_by'] as string | null, loginToId);
            await sql`
                insert into song_queue (channel_id, track_uri, track_name, artist_name,
                                        requested_by_twitch_user_id, requested_by_login, queue_position, added_at)
                values (${channelId}, ${String(row['track_uri'])}, ${row['track_name']}, ${row['artist_name']},
                        ${requester.twitchUserId}, ${requester.login}, ${row['queue_position'] ?? 0}, ${row['added_at']})
            `;
            bump('song_queue');
        }

        // ---- viewing_sessions ------------------------------------------------------
        const [sessionRows] = await my.query<mysql.RowDataPacket[]>(
            'SELECT user_id, stream_id, start_time, end_time FROM viewing_sessions'
        );
        for (const row of sessionRows) {
            const streamUuid = legacyStreamToUuid.get(String(row['stream_id']));
            const userId = String(row['user_id']);
            if (!streamUuid || !idSeen.has(userId)) {
                bump('viewing_sessions.skipped_orphaned');
                continue;
            }
            await sql`
                insert into viewing_sessions (channel_id, stream_id, twitch_user_id, started_at, ended_at)
                values (${channelId}, ${streamUuid}, ${userId}, ${row['start_time']}, ${row['end_time']})
            `;
            bump('viewing_sessions');
        }

        // ---- chat_messages ---------------------------------------------------------
        const [messageRows] = await my.query<mysql.RowDataPacket[]>(
            'SELECT user_id, stream_id, message_time, message_type, message_content FROM chat_messages'
        );
        for (const row of messageRows) {
            const userId = String(row['user_id']);
            if (!idSeen.has(userId)) {
                bump('chat_messages.skipped_unknown_user');
                continue;
            }
            await sql`
                insert into chat_messages (channel_id, stream_id, twitch_user_id, message_type, content, message_time)
                values (${channelId}, ${legacyStreamToUuid.get(String(row['stream_id'])) ?? null}, ${userId},
                        ${String(row['message_type'] ?? 'message')}, ${row['message_content']}, ${row['message_time']})
            `;
            bump('chat_messages');
        }

        // ---- chat_totals -------------------------------------------------------------
        const [totalRows] = await my.query<mysql.RowDataPacket[]>(
            'SELECT user_id, message_count, command_count, redemption_count, total_count FROM chat_totals'
        );
        for (const row of totalRows) {
            const userId = String(row['user_id']);
            if (!idSeen.has(userId)) {
                bump('chat_totals.skipped_unknown_user');
                continue;
            }
            await sql`
                insert into chat_totals (channel_id, twitch_user_id, message_count, command_count, redemption_count, total_count)
                values (${channelId}, ${userId}, ${row['message_count'] ?? 0}, ${row['command_count'] ?? 0},
                        ${row['redemption_count'] ?? 0}, ${row['total_count'] ?? 0})
            `;
            bump('chat_totals');
        }

        // ---- api_usage ------------------------------------------------------------------
        const [usageRows] = await my.query<mysql.RowDataPacket[]>(
            'SELECT user_id, api_type, stream_id, stream_count FROM api_usage'
        );
        for (const row of usageRows) {
            const userId = String(row['user_id']);
            if (!idSeen.has(userId)) {
                bump('api_usage.skipped_unknown_user');
                continue;
            }
            await sql`
                insert into api_usage (channel_id, twitch_user_id, stream_id, api_type, usage_count)
                values (${channelId}, ${userId}, ${legacyStreamToUuid.get(String(row['stream_id'])) ?? null},
                        ${String(row['api_type'])}, ${row['stream_count'] ?? 0})
                on conflict do nothing
            `;
            bump('api_usage');
        }

        // ---- report (counts only, never values) ---------------------------------------
        console.log('\nImport complete. Row counts by destination:\n');
        for (const key of Object.keys(counts).sort()) {
            console.log(`  ${key.padEnd(40)} ${counts[key]}`);
        }
        console.log('\n  (token values are never logged; server secrets are intentionally not imported)\n');
    } finally {
        await my.end();
        await sql.end({ timeout: 5 });
    }
}

void main().catch((err: unknown) => {
    // Deliberately selective: a raw driver error can echo the connection string,
    // which for this script contains credentials. Name/code/message only.
    if (err instanceof Error) {
        const detail = err as Error & { code?: string; detail?: string; constraint_name?: string };
        console.error('ETL failed:', detail.name, detail.code ?? '', detail.message);
        if (detail.detail) console.error('  detail:', detail.detail);
        if (detail.constraint_name) console.error('  constraint:', detail.constraint_name);
    } else {
        console.error('ETL failed:', String(err));
    }
    process.exit(1);
});
