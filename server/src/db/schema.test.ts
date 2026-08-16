import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import type { DbHandle } from './client.js';
import { runMigrations } from './migrate.js';
import { connectTestDatabase } from './testing.js';

/**
 * Schema constraint checks against a real Postgres.
 *
 * Skipped automatically when TEST_DATABASE_URL is unset, so `npm test` stays
 * dependency-free for anyone without Docker running. CI sets it, so the
 * constraints are genuinely enforced there.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('schema v2 against a real Postgres', () => {
    let handle: DbHandle;
    let sql: postgres.Sql;

    beforeAll(async () => {
        // Waits for a warming Postgres rather than failing on a cold stack.
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        sql = handle.sql;
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    /** Fresh channel per test, so tests cannot leak into one another. */
    const makeChannel = async (suffix: string): Promise<string> => {
        const [row] = await sql<{ id: string }[]>`
            insert into channels (twitch_broadcaster_id, twitch_login)
            values (${`test-${suffix}-${Date.now()}`}, ${`login-${suffix}`})
            returning id
        `;
        return row!.id;
    };

    const makeViewer = async (id: string): Promise<void> => {
        await sql`
            insert into viewers (twitch_user_id, login) values (${id}, ${`user-${id}`})
            on conflict (twitch_user_id) do nothing
        `;
    };

    describe('migrations', () => {
        it('creates every expected table', async () => {
            const rows = await sql<{ tablename: string }[]>`
                select tablename from pg_tables where schemaname = 'public' order by tablename
            `;
            const names = rows.map((r) => r.tablename);

            for (const expected of [
                'api_usage', 'bot_identity', 'channel_roles', 'channel_settings', 'channel_tokens',
                'channels', 'chat_messages', 'chat_totals', 'commands', 'editors', 'emotes',
                'quotes', 'song_queue', 'streams', 'viewers', 'viewing_sessions'
            ]) {
                expect(names).toContain(expected);
            }
        });

        it('is idempotent - re-running applies nothing new', async () => {
            await expect(runMigrations(handle)).resolves.toBeUndefined();
        });

        it('leaves no identifier truncated by Postgres', async () => {
            // An identifier over 63 chars is silently shortened, so the name in
            // the migration file stops matching the name in the database.
            const rows = await sql<{ conname: string }[]>`
                select conname from pg_constraint where length(conname) >= 63
            `;
            expect(rows).toEqual([]);
        });
    });

    describe('channel scoping', () => {
        it('allows the same command name in two different channels', async () => {
            const a = await makeChannel('cmd-a');
            const b = await makeChannel('cmd-b');

            await sql`insert into commands (channel_id, name) values (${a}, '!discord')`;
            await expect(
                sql`insert into commands (channel_id, name) values (${b}, '!discord')`
            ).resolves.toBeDefined();
        });

        it('rejects a duplicate command name WITHIN one channel', async () => {
            const channel = await makeChannel('cmd-dup');

            await sql`insert into commands (channel_id, name) values (${channel}, '!dup')`;
            await expect(
                sql`insert into commands (channel_id, name) values (${channel}, '!dup')`
            ).rejects.toThrow();
        });

        it('scopes emote triggers per channel', async () => {
            const a = await makeChannel('emote-a');
            const b = await makeChannel('emote-b');

            await sql`insert into emotes (channel_id, trigger_text, response_text) values (${a}, 'pog', 'x')`;
            await expect(
                sql`insert into emotes (channel_id, trigger_text, response_text) values (${b}, 'pog', 'y')`
            ).resolves.toBeDefined();
            await expect(
                sql`insert into emotes (channel_id, trigger_text, response_text) values (${a}, 'pog', 'z')`
            ).rejects.toThrow();
        });

        it('scopes quote numbers per channel so each starts at 1', async () => {
            const a = await makeChannel('quote-a');
            const b = await makeChannel('quote-b');

            await sql`insert into quotes (channel_id, quote_number, quote_text) values (${a}, 1, 'first')`;
            await expect(
                sql`insert into quotes (channel_id, quote_number, quote_text) values (${b}, 1, 'also first')`
            ).resolves.toBeDefined();
        });

        it('allows one credential set per provider per channel', async () => {
            const channel = await makeChannel('tok');

            await sql`insert into channel_tokens (channel_id, provider, access_token, refresh_token) values (${channel}, 'twitch', 'a', 'r')`;
            await sql`insert into channel_tokens (channel_id, provider, access_token, refresh_token) values (${channel}, 'spotify', 'a', 'r')`;
            await expect(
                sql`insert into channel_tokens (channel_id, provider, access_token, refresh_token) values (${channel}, 'twitch', 'b', 's')`
            ).rejects.toThrow();
        });

        it('rejects an unknown provider', async () => {
            const channel = await makeChannel('tok-bad');

            await expect(
                sql`insert into channel_tokens (channel_id, provider, access_token, refresh_token) values (${channel}, 'youtube', 'a', 'r')`
            ).rejects.toThrow();
        });

        it('permits one tenant per Twitch broadcaster id', async () => {
            const id = `dupe-${Date.now()}`;
            await sql`insert into channels (twitch_broadcaster_id, twitch_login) values (${id}, 'a')`;
            await expect(
                sql`insert into channels (twitch_broadcaster_id, twitch_login) values (${id}, 'b')`
            ).rejects.toThrow();
        });
    });

    describe('ON DELETE behaviour', () => {
        it('CASCADEs a channel deletion through its owned content', async () => {
            const channel = await makeChannel('cascade');
            await sql`insert into commands (channel_id, name) values (${channel}, '!gone')`;
            await sql`insert into channel_settings (channel_id) values (${channel})`;

            await sql`delete from channels where id = ${channel}`;

            const commands = await sql`select 1 from commands where channel_id = ${channel}`;
            const settings = await sql`select 1 from channel_settings where channel_id = ${channel}`;
            expect(commands).toHaveLength(0);
            expect(settings).toHaveLength(0);
        });

        it('CASCADEs credentials so no orphaned secret survives its channel', async () => {
            const channel = await makeChannel('cascade-tok');
            await sql`insert into channel_tokens (channel_id, provider, access_token, refresh_token) values (${channel}, 'twitch', 'a', 'r')`;

            await sql`delete from channels where id = ${channel}`;

            expect(await sql`select 1 from channel_tokens where channel_id = ${channel}`).toHaveLength(0);
        });

        it('RESTRICTs deleting a viewer that a channel still references', async () => {
            const channel = await makeChannel('restrict');
            const userId = `restrict-${Date.now()}`;
            await makeViewer(userId);
            await sql`insert into channel_roles (channel_id, twitch_user_id) values (${channel}, ${userId})`;

            // A viewer is shared across channels; deleting identity out from under
            // another channel's history must be deliberate, not incidental.
            await expect(sql`delete from viewers where twitch_user_id = ${userId}`).rejects.toThrow();
        });

        it('CASCADEs a stream deletion through its viewing sessions', async () => {
            const channel = await makeChannel('stream-cascade');
            const userId = `sc-${Date.now()}`;
            await makeViewer(userId);

            const [stream] = await sql<{ id: string }[]>`
                insert into streams (channel_id, started_at) values (${channel}, now()) returning id
            `;
            await sql`
                insert into viewing_sessions (channel_id, stream_id, twitch_user_id, started_at)
                values (${channel}, ${stream!.id}, ${userId}, now())
            `;

            await sql`delete from streams where id = ${stream!.id}`;

            expect(await sql`select 1 from viewing_sessions where stream_id = ${stream!.id}`).toHaveLength(0);
        });

        it('SET NULLs a song request rather than deleting the song', async () => {
            const channel = await makeChannel('song-null');
            const userId = `song-${Date.now()}`;
            await makeViewer(userId);

            await sql`
                insert into song_queue (channel_id, track_uri, requested_by_twitch_user_id, requested_by_login, queue_position)
                values (${channel}, 'spotify:track:x', ${userId}, 'someone', 1)
            `;
            await sql`delete from channel_roles where twitch_user_id = ${userId}`;
            await sql`delete from viewers where twitch_user_id = ${userId}`;

            const [song] = await sql<{ requested_by_twitch_user_id: string | null; requested_by_login: string }[]>`
                select requested_by_twitch_user_id, requested_by_login from song_queue where channel_id = ${channel}
            `;
            expect(song?.requested_by_twitch_user_id).toBeNull();
            // The display name survives so the queue entry is still meaningful.
            expect(song?.requested_by_login).toBe('someone');
        });
    });

    describe('column constraints', () => {
        it('defaults a command to the everyone level', async () => {
            const channel = await makeChannel('level');
            const [row] = await sql<{ user_level: string }[]>`
                insert into commands (channel_id, name) values (${channel}, '!lvl') returning user_level
            `;
            expect(row?.user_level).toBe('everyone');
        });

        it('accepts the vip level added in Phase 0 WP-7.1', async () => {
            const channel = await makeChannel('vip');
            await expect(
                sql`insert into commands (channel_id, name, user_level) values (${channel}, '!v', 'vip')`
            ).resolves.toBeDefined();
        });

        it('rejects an unknown user level', async () => {
            const channel = await makeChannel('bad-level');
            await expect(
                sql`insert into commands (channel_id, name, user_level) values (${channel}, '!x', 'wizard')`
            ).rejects.toThrow();
        });

        it('accepts any api_type string, closing the single-value ENUM item', async () => {
            const channel = await makeChannel('api');
            const userId = `api-${Date.now()}`;
            await makeViewer(userId);

            // The Phase-0 schema had ENUM('claude'); adding a provider needed a
            // migration. A varchar means it does not.
            await expect(
                sql`insert into api_usage (channel_id, twitch_user_id, api_type, usage_count) values (${channel}, ${userId}, 'some-future-model', 1)`
            ).resolves.toBeDefined();
        });

        it('requires a channel on tenant-scoped rows', async () => {
            await expect(sql`insert into commands (name) values ('!orphan')`).rejects.toThrow();
        });
    });
});
