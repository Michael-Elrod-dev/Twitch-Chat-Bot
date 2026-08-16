/**
 * Representative seed data for the restore drill and local development.
 *
 * Deliberately synthetic: it must exercise every table and constraint the drill
 * asserts on, without any resemblance to real credentials or real viewers.
 */
import { loadDatabaseEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';

const env = loadDatabaseEnv();
const handle = createDb(env);
const { sql } = handle;

try {
    const [channel] = await sql<{ id: string }[]>`
        insert into channels (twitch_broadcaster_id, twitch_login, display_name)
        values ('900000001', 'seedchannel', 'Seed Channel')
        on conflict (twitch_broadcaster_id) do update set updated_at = now()
        returning id
    `;
    const channelId = channel!.id;

    await sql`
        insert into channel_settings (channel_id, ai_enabled)
        values (${channelId}, true)
        on conflict (channel_id) do nothing
    `;

    await sql`
        insert into channel_tokens (channel_id, provider, access_token, refresh_token, scopes)
        values (${channelId}, 'twitch', 'seed-access', 'seed-refresh', ${JSON.stringify(['channel:bot'])}::jsonb)
        on conflict (channel_id, provider) do nothing
    `;

    await sql`
        insert into bot_identity (twitch_user_id, twitch_login, granted_scopes)
        values ('900000999', 'seedbot', ${JSON.stringify(['user:bot'])}::jsonb)
        on conflict (twitch_user_id) do nothing
    `;

    for (let i = 1; i <= 5; i++) {
        await sql`
            insert into viewers (twitch_user_id, login)
            values (${`90000010${i}`}, ${`seeduser${i}`})
            on conflict (twitch_user_id) do nothing
        `;
        await sql`
            insert into channel_roles (channel_id, twitch_user_id, is_moderator, last_seen_at)
            values (${channelId}, ${`90000010${i}`}, ${i === 1}, now())
            on conflict (channel_id, twitch_user_id) do nothing
        `;
    }

    const [stream] = await sql<{ id: string }[]>`
        insert into streams (channel_id, twitch_stream_id, started_at, ended_at, title, category)
        values (${channelId}, 'seed-stream-1', now() - interval '2 hours', now() - interval '1 hour',
                'Seed Stream', 'Software and Game Development')
        on conflict (channel_id, twitch_stream_id) do update set title = excluded.title
        returning id
    `;
    const streamId = stream!.id;

    await sql`
        insert into commands (channel_id, name, response_text, user_level)
        values (${channelId}, '!seed', 'seeded response', 'everyone')
        on conflict (channel_id, name) do nothing
    `;
    await sql`
        insert into emotes (channel_id, trigger_text, response_text)
        values (${channelId}, 'seedmote', 'seeded!')
        on conflict (channel_id, trigger_text) do nothing
    `;
    await sql`
        insert into quotes (channel_id, quote_number, quote_text, author, saved_by_twitch_user_id)
        values (${channelId}, 1, 'a seeded quote', 'seeduser1', '900000101')
        on conflict (channel_id, quote_number) do nothing
    `;
    await sql`
        insert into song_queue (channel_id, track_uri, track_name, artist_name,
                                requested_by_twitch_user_id, requested_by_login, queue_position)
        values (${channelId}, 'spotify:track:seed', 'Seed Song', 'Seed Artist', '900000101', 'seeduser1', 1)
    `;

    for (let i = 1; i <= 5; i++) {
        await sql`
            insert into viewing_sessions (channel_id, stream_id, twitch_user_id, started_at, ended_at)
            values (${channelId}, ${streamId}, ${`90000010${i}`}, now() - interval '2 hours', now() - interval '1 hour')
        `;
        await sql`
            insert into chat_messages (channel_id, stream_id, twitch_user_id, message_type, content, message_time)
            values (${channelId}, ${streamId}, ${`90000010${i}`}, 'message', ${`seed message ${i}`}, now())
        `;
        await sql`
            insert into chat_totals (channel_id, twitch_user_id, message_count, total_count)
            values (${channelId}, ${`90000010${i}`}, 1, 1)
            on conflict (channel_id, twitch_user_id) do nothing
        `;
        await sql`
            insert into api_usage (channel_id, twitch_user_id, stream_id, api_type, usage_count)
            values (${channelId}, ${`90000010${i}`}, ${streamId}, 'claude', ${i})
            on conflict do nothing
        `;
    }

    console.log('Seed data written.');
} finally {
    await handle.close();
}
