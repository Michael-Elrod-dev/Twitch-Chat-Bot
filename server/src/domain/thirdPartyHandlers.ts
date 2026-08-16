import type { HandlerRegistry, HandlerContext } from './handlers.js';

/**
 * `!fursona` and `!waifu` — the joke commands.
 *
 * Neither calls an API. Both hash the username into a stable seed and post a
 * URL, so the same person always gets the same picture and the bot makes no
 * network request at all. That is worth stating because it also means there is
 * no API key, no rate limit and no terms of service to accept — only a host
 * that has to still be serving the file.
 *
 * ## Health check, 2026-08-16
 *
 * Both hosts were checked before porting rather than assumed:
 *
 *   thisfursonadoesnotexist.com/v2/jpgs-2x/seed00042.jpg   200, image/jpeg, 122 KB — ALIVE
 *   arfa.dev/waifu-ed/editor_d6a3dae.html?seed=12345       404 — DEAD
 *   arfa.dev/waifu-ed/                                     404 (nginx) — the whole path is gone
 *
 * So `!fursona` ports unchanged. `!waifu`'s host removed the project, not just
 * renamed a build artifact, and porting the dead URL would have shipped a
 * command that posts a broken link to every viewer who runs it.
 *
 * The replacement is `thiswaifudoesnotexist.net`, verified 200/image-jpeg and
 * structurally identical to the fursona site: a seed maps to a deterministic
 * image, so the "same person always gets the same picture" property survives.
 * **This substitution is the owner's call to keep or drop** — it is flagged in
 * the P1-WP4.4 report, and dropping it means deleting this handler and the
 * `!waifu` command row together.
 */

const FURSONA_SEED_MIN = 1;
const FURSONA_SEED_MAX = 100_000;

/** TWDNE serves example-1 .. example-100000. */
const WAIFU_SEED_MIN = 1;
const WAIFU_SEED_MAX = 100_000;

/**
 * Phase 0's hash, kept exactly.
 *
 * Changing it would reassign everyone's picture, and the whole point of the
 * command is that yours is yours. `Math.abs` on the result is load-bearing:
 * the shift keeps it a signed 32-bit int, so it can be negative.
 */
function hashCode(value: string): number {
    let hash = 0;
    for (const character of value) {
        hash = ((hash << 5) - hash) + character.charCodeAt(0);
        hash |= 0;
    }
    return hash;
}

function seedFor(username: string, min: number, max: number): string {
    const range = max - min;
    return String(min + (Math.abs(hashCode(username)) % range)).padStart(5, '0');
}

/** `!fursona @name`, or the caller. */
function targetOf(context: HandlerContext): string {
    const requested = (context.args[0] ?? '').replace('@', '').trim();
    return requested === '' ? context.chatter.displayName : requested;
}

export function createThirdPartyHandlers(): HandlerRegistry {
    return {
        /* Handler names match the rows already in the owner's database. */
        fursona: {
            level: 'everyone',
            handler: async (context: HandlerContext): Promise<void> => {
                const target = targetOf(context);
                const seed = seedFor(target, FURSONA_SEED_MIN, FURSONA_SEED_MAX);

                await context.reply(
                    `@${target}, here is your fursona `
                    + `https://thisfursonadoesnotexist.com/v2/jpgs-2x/seed${seed}.jpg`
                );
            }
        },

        waifu: {
            level: 'everyone',
            handler: async (context: HandlerContext): Promise<void> => {
                const target = targetOf(context);
                // Not padded: TWDNE's filenames are example-1, not example-00001.
                const seed = Number(seedFor(target, WAIFU_SEED_MIN, WAIFU_SEED_MAX));

                await context.reply(
                    `@${target}, here is your waifu `
                    + `https://www.thiswaifudoesnotexist.net/example-${seed}.jpg`
                );
            }
        }
    };
}
