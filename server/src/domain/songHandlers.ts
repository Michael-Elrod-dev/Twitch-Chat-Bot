import type { HandlerRegistry, HandlerContext } from './handlers.js';
import type { SongQueueRepository } from '../db/repositories/songQueueRepository.js';
import type { SpotifyClient } from '../spotify/spotifyClient.js';
import type { SongToggleService } from './songToggle.js';
import type { Logger } from '../logger.js';
import { ManualReauthRequiredError } from '../twitch/errors.js';

/**
 * The song chat commands.
 *
 * Levels are declared here and the declaration wins. `CommandManager` corrects
 * a database row that disagrees, so the table can never quietly claim `!skip`
 * is available to everyone.
 *
 * Every handler answers something. A command that silently does nothing is
 * indistinguishable from a broken bot, so "the queue is empty" and "Spotify is
 * not connected" are replies rather than silences.
 */

export interface SongHandlerDeps {
    queue: SongQueueRepository;
    spotify: SpotifyClient | null;
    toggle: SongToggleService;
    logger: Logger;
    /**
     * The last track the monitor advanced to.
     *
     * Held in memory by the monitor rather than persisted: `!lastsong` is a
     * within-session convenience, and a restart legitimately has no answer.
     */
    lastPlayed: () => { trackName: string; artistName: string } | null;
}

const NOT_CONNECTED = 'Spotify is not connected for this channel.';

/** Formats a track for chat. */
const describe = (name: string, artist: string): string => `${name} by ${artist}`;

export function createSongHandlers(deps: SongHandlerDeps): HandlerRegistry {
    const currentlyPlaying = async (context: HandlerContext): Promise<void> => {
        if (!deps.spotify) {
            await context.reply(NOT_CONNECTED);
            return;
        }

        try {
            const state = await deps.spotify.getPlaybackState();
            if (!state?.trackUri) {
                await context.reply('Nothing is playing right now.');
                return;
            }

            // The player reports a URI; the queue holds the metadata we stored
            // when it was requested, which is cheaper than another lookup.
            const queued = (await deps.queue.list()).find((s) => s.trackUri === state.trackUri);
            await context.reply(
                queued
                    ? `Now playing: ${describe(queued.trackName, queued.artistName)}`
                    : 'Now playing something not from the request queue.'
            );
        } catch (err) {
            if (err instanceof ManualReauthRequiredError) {
                await context.reply(NOT_CONNECTED);
                return;
            }
            deps.logger.warn({ err: (err as Error).message }, '!song failed');
            await context.reply('I could not reach Spotify just now.');
        }
    };

    /*
     * Names match the handler_name values the imported data already carries
     * (currentSong, lastSong, nextSong, queueInfo, skipSong, toggleSongs). The
     * rows belong to the owner, so the handler names are what bend.
     */
    return {
        currentSong: { level: 'everyone', description: 'Names the song playing now', handler: currentlyPlaying },

        lastSong: {
            level: 'everyone',
            description: 'Names the song that just played',
            handler: async (context) => {
                const last = deps.lastPlayed();
                await context.reply(
                    last
                        ? `Last played: ${describe(last.trackName, last.artistName)}`
                        : 'I have not advanced the queue yet this session.'
                );
            }
        },

        nextSong: {
            level: 'everyone',
            description: 'Names the song coming up',
            handler: async (context) => {
                const [next] = await deps.queue.list();
                await context.reply(
                    next
                        ? `Up next: ${describe(next.trackName, next.artistName)}`
                        : 'Nothing is queued.'
                );
            }
        },

        queueInfo: {
            level: 'everyone',
            description: 'Reports how many songs are waiting',
            handler: async (context) => {
                const queued = await deps.queue.list();
                if (queued.length === 0) {
                    await context.reply('The queue is empty.');
                    return;
                }

                // Five is what fits a chat line without becoming a wall.
                const shown = queued.slice(0, 5)
                    .map((s, i) => `${i + 1}. ${describe(s.trackName, s.artistName)}`)
                    .join(' | ');
                const more = queued.length > 5 ? ` (+${queued.length - 5} more)` : '';

                await context.reply(`${shown}${more}`);
            }
        },

        skipSong: {
            // Mods only: skipping removes something a viewer paid points for.
            level: 'mod',
            description: 'Skips the current song',
            handler: async (context) => {
                const removed = await deps.queue.removeHead();
                await context.reply(
                    removed
                        ? `Skipped ${describe(removed.trackName, removed.artistName)}.`
                        : 'There is nothing in the queue to skip.'
                );
            }
        },

        toggleSongs: {
            level: 'mod',
            description: 'Opens and closes song requests',
            handler: async (context) => {
                const arg = (context.args[0] ?? '').toLowerCase();

                if (arg !== 'on' && arg !== 'off') {
                    const enabled = await deps.toggle.isEnabled();
                    await context.reply(
                        `Song requests are currently ${enabled ? 'on' : 'off'}. Use !songs on or !songs off.`
                    );
                    return;
                }

                const result = await deps.toggle.setEnabled(arg === 'on');

                // The partial-failure case is reported honestly: the setting
                // changed but the reward is still on screen, and a mod who does
                // not know that will wonder why viewers can still redeem.
                await context.reply(
                    result.rewardUpdated
                        ? `Song requests are now ${result.enabled ? 'on' : 'off'}.`
                        : `Song requests are now ${result.enabled ? 'on' : 'off'}, but I could not update the channel-point reward.`
                );
            }
        }
    };
}
