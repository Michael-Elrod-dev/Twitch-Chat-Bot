import type { ChannelRecord } from '../db/repositories/channelRepository.js';
import type { ChannelSession } from './channelSession.js';

/**
 * Making the running server agree with the database about which channels should
 * have a session.
 *
 * Extracted from the composition root so it can be tested against a real
 * `SessionManager` rather than a spy. The distinction this file exists to keep
 * is the one the whole master switch rests on: `status` is what the world did to
 * a channel, `enabled` is what its owner chose. Neither is inferred from the
 * other here. `listActive()` is the single place both are consulted, and it
 * requires both to hold.
 */

export interface ChannelSwitchPorts {
    /** Channels that should be running: Twitch permits it AND the owner wants it. */
    listActive: () => Promise<ChannelRecord[]>;
    sessions: {
        add: (session: ChannelSession) => Promise<void>;
        remove: (channelId: string) => Promise<void>;
    };
    buildSession: (channel: ChannelRecord) => ChannelSession;
}

/**
 * Rebuilds one channel session in place.
 *
 * A session captures its capabilities at construction, meaning the Spotify
 * client, the playback monitor, the redemption handlers and the bot identity,
 * so a capability acquired at runtime needs the session rebuilt before it takes
 * effect. Every path that grants one at runtime goes through this one function
 * rather than reinventing it, because a grant applied only at boot leaves the
 * running session without it.
 *
 * Removed and re-added individually rather than via `stopAll()`, which would
 * also stop the transport and close the ingest queue.
 */
export async function rebuildChannelSession(
    ports: ChannelSwitchPorts,
    channelId: string
): Promise<void> {
    const channel = (await ports.listActive()).find((c) => c.id === channelId);
    if (!channel) return;

    await ports.sessions.remove(channelId);
    await ports.sessions.add(ports.buildSession(channel));
}

/**
 * Makes the running server match the owner's master switch.
 *
 * Called after the flag is persisted, so `listActive()` already agrees about
 * this channel. Switching off is a plain removal. There is no
 * "stopped but registered" state to leave behind, and `remove` is a no-op when
 * nothing is running, which makes a repeated flip harmless.
 *
 * Switching on deliberately goes through the rebuild rather than a bare `add`:
 * a channel that was off may have gained or lost capabilities meanwhile, and a
 * session restored from stale wiring is the failure mode `rebuildChannelSession`
 * was written for.
 *
 * Every operation is keyed by the `channelId` it was given and no other, which
 * is what keeps one broadcaster's switch off another broadcaster's bot.
 */
export async function applyChannelEnabled(
    ports: ChannelSwitchPorts,
    channelId: string,
    enabled: boolean
): Promise<void> {
    if (!enabled) {
        await ports.sessions.remove(channelId);
        return;
    }

    await rebuildChannelSession(ports, channelId);
}
