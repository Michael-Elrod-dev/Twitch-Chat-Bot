import type { HandlerRegistry, HandlerContext } from './handlers.js';

/**
 * `!fursona` and `!waifu`, the joke commands.
 *
 * Neither calls an API. Both hash the username into a stable seed and post a
 * URL, so the same person always gets the same picture and the bot makes no
 * network request at all. That is worth stating because it also means there is
 * no API key, no rate limit and no terms of service to accept, only a host that
 * has to still be serving the file.
 *
 * The waifu host is `thiswaifudoesnotexist.net`. The `arfa.dev/waifu-ed/` path
 * serves 404 for the whole directory and must never be used, because a dead URL
 * here posts a broken link to every viewer who runs the command. The live host
 * is structurally identical to the fursona site, a seed maps to a deterministic
 * image, so the "same person always gets the same picture" property holds.
 * Keeping or dropping that substitution is the owner's call, and dropping it
 * means deleting this handler and the `!waifu` command row together.
 */

const FURSONA_SEED_MIN = 1;
const FURSONA_SEED_MAX = 100_000;

/** TWDNE serves example-1 .. example-100000. */
const WAIFU_SEED_MIN = 1;
const WAIFU_SEED_MAX = 100_000;

/**
 * The current salt era.
 *
 * Every image association is `hash(salt + ':' + username)`, so bumping the salt
 * reassigns everyone at once and nothing else has to change. A wipe is a salt
 * bump, and it takes effect on the next deploy.
 *
 * Within an era the mapping is fixed, the same person gets the same picture for
 * as long as the salt holds, because "yours is yours" is the point of the
 * command. Across eras it deliberately is not.
 *
 * Overridable with `IMAGE_SEED_SALT` so a reset does not require a code change.
 * This constant is the default and is bumped when the default should move.
 */
export const DEFAULT_IMAGE_SEED_SALT = '2026-08-16a';

/**
 * The seed hash.
 *
 * The salt is mixed into its input rather than changing the algorithm. The
 * function's distribution is known good, and a bump should reshuffle the
 * mapping without altering how it is computed. `Math.abs` on the result is
 * load-bearing, because the shift keeps it a signed 32-bit int so it can be
 * negative.
 */
function hashCode(value: string): number {
    let hash = 0;
    for (const character of value) {
        hash = ((hash << 5) - hash) + character.charCodeAt(0);
        hash |= 0;
    }
    return hash;
}

export function seedFor(username: string, min: number, max: number, salt: string): string {
    const range = max - min;
    // Lowercased so `@Name` and `@name` are one person, as the lookups elsewhere
    // already treat them.
    const keyed = `${salt}:${username.toLowerCase()}`;
    return String(min + (Math.abs(hashCode(keyed)) % range)).padStart(5, '0');
}

/** `!fursona @name`, or the caller. */
function targetOf(context: HandlerContext): string {
    const requested = (context.args[0] ?? '').replace('@', '').trim();
    return requested === '' ? context.chatter.displayName : requested;
}

export interface ThirdPartyHandlerDeps {
    /** The salt era. Defaults to the constant above. */
    salt?: string;
}

export function createThirdPartyHandlers(deps: ThirdPartyHandlerDeps = {}): HandlerRegistry {
    const salt = deps.salt ?? DEFAULT_IMAGE_SEED_SALT;

    return {
        /* Handler names match the rows already in the owner's database. */
        fursona: {
            level: 'everyone',
            description: 'Generates a fursona image',
            handler: async (context: HandlerContext): Promise<void> => {
                const target = targetOf(context);
                const seed = seedFor(target, FURSONA_SEED_MIN, FURSONA_SEED_MAX, salt);

                await context.reply(
                    `@${target}, here is your fursona `
                    + `https://thisfursonadoesnotexist.com/v2/jpgs-2x/seed${seed}.jpg`
                );
            }
        },

        waifu: {
            level: 'everyone',
            description: 'Generates a waifu image',
            handler: async (context: HandlerContext): Promise<void> => {
                const target = targetOf(context);
                // Not padded, because the filenames are example-1, not example-00001.
                const seed = Number(seedFor(target, WAIFU_SEED_MIN, WAIFU_SEED_MAX, salt));

                await context.reply(
                    `@${target}, here is your waifu `
                    + `https://www.thiswaifudoesnotexist.net/example-${seed}.jpg`
                );
            }
        }
    };
}
