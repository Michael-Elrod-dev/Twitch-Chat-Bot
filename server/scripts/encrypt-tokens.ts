/**
 * One-time upgrade: encrypts token rows that were written before encryption existed.
 *
 * The ETL imported the recovered production dump with token values as plaintext.
 * This walks those rows and rewrites each one encrypted, in place.
 *
 * Properties that make it safe to run:
 *   - **Idempotent.** An already-encrypted row is skipped, so running it twice
 *     is not a double-encryption.
 *   - **Per-row transactional.** A crash halfway leaves every processed row
 *     valid; the next run finishes the rest.
 *   - **Silent about values.** It reports counts. It never prints a token, not
 *     even a prefix, not even on failure.
 *
 *   npm run db:encrypt-tokens -w server
 *   npm run db:encrypt-tokens -w server -- --dry-run
 */
import { loadDatabaseEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import { createTokenCipher } from '../src/crypto/tokenCipher.js';
import { TOKEN_PURPOSES } from '../src/crypto/tokenCipher.js';
import { isEncrypted } from '../src/crypto/tokenCrypto.js';

const dryRun = process.argv.includes('--dry-run');

const key = process.env['TOKEN_ENCRYPTION_KEY'];
if (!key) {
    console.error('TOKEN_ENCRYPTION_KEY is not set. Generate one with:');
    console.error(String.raw`  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`);
    process.exit(78);
}

const cipher = createTokenCipher(key);
const handle = createDb(loadDatabaseEnv());
const { sql } = handle;

interface Counts {
    scanned: number;
    encrypted: number;
    alreadyEncrypted: number;
    failed: number;
}

const channelCounts: Counts = { scanned: 0, encrypted: 0, alreadyEncrypted: 0, failed: 0 };
const botCounts: Counts = { scanned: 0, encrypted: 0, alreadyEncrypted: 0, failed: 0 };

try {
    const channelRows = await sql<{ id: string; access_token: string; refresh_token: string }[]>`
        select id, access_token, refresh_token from channel_tokens
    `;

    for (const row of channelRows) {
        channelCounts.scanned++;

        const accessDone = isEncrypted(row.access_token);
        const refreshDone = isEncrypted(row.refresh_token);

        if (accessDone && refreshDone) {
            channelCounts.alreadyEncrypted++;
            continue;
        }

        if (dryRun) {
            channelCounts.encrypted++;
            continue;
        }

        try {
            // Both columns in one statement: a row with one column encrypted and
            // the other not would be unreadable by the strict read path.
            const access = accessDone
                ? row.access_token
                : cipher.encrypt(row.access_token, TOKEN_PURPOSES.channelAccess);
            const refresh = refreshDone
                ? row.refresh_token
                : cipher.encrypt(row.refresh_token, TOKEN_PURPOSES.channelRefresh);

            await sql`
                update channel_tokens
                set access_token = ${access}, refresh_token = ${refresh}, updated_at = now()
                where id = ${row.id}
            `;
            channelCounts.encrypted++;
        } catch (err) {
            channelCounts.failed++;
            // The row id is safe to name; the values are not, so only the error
            // *type* is reported.
            console.error(`channel_tokens ${row.id}: failed (${(err as Error).name})`);
        }
    }

    const botRows = await sql<{ id: string; refresh_token: string | null }[]>`
        select id, refresh_token from bot_identity where refresh_token is not null
    `;

    for (const row of botRows) {
        botCounts.scanned++;
        if (!row.refresh_token) continue;

        if (isEncrypted(row.refresh_token)) {
            botCounts.alreadyEncrypted++;
            continue;
        }

        if (dryRun) {
            botCounts.encrypted++;
            continue;
        }

        try {
            const encrypted = cipher.encrypt(row.refresh_token, TOKEN_PURPOSES.botRefresh);
            await sql`
                update bot_identity set refresh_token = ${encrypted}, updated_at = now() where id = ${row.id}
            `;
            botCounts.encrypted++;
        } catch (err) {
            botCounts.failed++;
            console.error(`bot_identity ${row.id}: failed (${(err as Error).name})`);
        }
    }

    console.log(dryRun ? 'DRY RUN - nothing was written' : 'Token encryption upgrade complete');
    console.log(`  channel_tokens : scanned ${channelCounts.scanned}, encrypted ${channelCounts.encrypted}, already ${channelCounts.alreadyEncrypted}, failed ${channelCounts.failed}`);
    console.log(`  bot_identity   : scanned ${botCounts.scanned}, encrypted ${botCounts.encrypted}, already ${botCounts.alreadyEncrypted}, failed ${botCounts.failed}`);

    if (channelCounts.failed + botCounts.failed > 0) process.exit(1);
} finally {
    await handle.close();
}
