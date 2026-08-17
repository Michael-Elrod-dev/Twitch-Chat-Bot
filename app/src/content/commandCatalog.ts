import type { UserLevel } from '@almosthadai/shared';

/**
 * What each built-in command does, in the broadcaster's words.
 *
 * **This lives client-side, and that is a compromise worth naming.** The
 * contract carries `handlerName` and nothing else — the server's handler
 * registry stores a function and a permission level, no description — so the
 * design's requirement that the reply column "describes the behaviour" has no
 * source on the wire. Two options existed: add a `description` to the contract,
 * or keep a map here. The contract addition was out of this package's scope
 * guard, so this is the map, with the cost stated plainly: **a built-in added
 * server-side will render the generic fallback until someone edits this file.**
 *
 * The fallback is deliberately truthful rather than blank — an unknown built-in
 * is still a built-in, and saying "a built-in behaviour" is honest where an
 * empty cell would read as a broken row.
 *
 * The proper home is next to each handler's registration, so the description
 * and the behaviour are changed in one place. Flagged for 9c or later.
 */
const BEHAVIOUR: Readonly<Record<string, string>> = {
    advice: 'Asks the AI for advice',
    combinedStats: 'Shows how much someone has chatted',
    currentSong: 'Names the song playing now',
    followAge: 'Says how long someone has followed',
    fursona: 'Generates a fursona image',
    lastSong: 'Names the song that just played',
    modCommands: 'Adds, edits and removes commands from chat',
    nextSong: 'Names the song coming up',
    queueInfo: 'Reports how many songs are waiting',
    quoteHandler: 'Returns a saved quote',
    roast: 'Asks the AI to roast someone',
    skipSong: 'Skips the current song',
    toggleAI: 'Turns AI replies on and off',
    toggleSongs: 'Opens and closes song requests',
    topStats: 'Lists the most active chatters',
    uptime: 'Says how long the stream has been live',
    waifu: 'Generates a waifu image'
};

/** @returns the behaviour text for a handler-backed command. Never empty. */
export function describeHandler(handlerName: string): string {
    return BEHAVIOUR[handlerName] ?? 'A built-in behaviour';
}

/**
 * The permission tiers as the WHO chips label them.
 *
 * `broadcaster` reads "Just you" rather than "Broadcaster": this app has one
 * user and it is the broadcaster, so the second person is both shorter and
 * what the design draws.
 */
export const USER_LEVEL_LABELS: Readonly<Record<UserLevel, string>> = {
    everyone: 'Everyone',
    vip: 'VIPs',
    mod: 'Mods',
    broadcaster: 'Just you'
};

/** The order the chips appear in, lowest tier first. */
export const USER_LEVEL_ORDER: readonly UserLevel[] = ['everyone', 'vip', 'mod', 'broadcaster'];
