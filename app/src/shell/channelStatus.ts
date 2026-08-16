import type { ChannelSummary } from '@almosthadai/shared';
import type { ConnectionState } from '../live/connection.js';

/**
 * What the header pill says, and why.
 *
 * A pure function on purpose: this is the single place where "our link to the
 * server" and "the state of the channel" meet, and it is therefore the single
 * place they could be conflated. The handoff's `4b` rule is absolute — when we
 * cannot reach the server we do not know anything about the channel, and the
 * honest answer is `unknown`, not `offline`. Telling a broadcaster their bot is
 * offline because our WebSocket dropped would be a lie about a bot that is
 * almost certainly still working.
 */

export type PillState = 'live' | 'offline' | 'needs_reauth' | 'unknown';

export interface PillInputs {
    connection: ConnectionState;
    /** Null while signed in with no channel connected. */
    channel: Pick<ChannelSummary, 'status'> | null;
    /** From the most recent `channel.status` event. */
    live: boolean;
}

export function resolvePillState(inputs: PillInputs): PillState {
    // Nothing we know about the channel is current, so we claim nothing.
    if (inputs.connection !== 'open') return 'unknown';
    if (!inputs.channel) return 'unknown';

    // Twitch withdrawing consent outranks live/offline: a channel that is
    // streaming while the bot is locked out is still `needs_reauth`, and
    // showing LIVE there would hide the one thing the user must act on.
    if (inputs.channel.status === 'needs_reauth') return 'needs_reauth';

    return inputs.live ? 'live' : 'offline';
}

/**
 * Whether the master switch can be operated.
 *
 * Inert when the server is unreachable (we could not act on the flip) or when
 * Twitch has revoked consent (flipping it would change nothing the user cares
 * about, and offering the control implies otherwise).
 */
export function isMasterSwitchOperable(inputs: PillInputs): boolean {
    if (inputs.connection !== 'open') return false;
    if (!inputs.channel) return false;
    return inputs.channel.status !== 'needs_reauth';
}

/** `LIVE 2:14:07` — ticks locally, re-synced on each `channel.status`. */
export function formatUptime(startedAt: Date, now: Date): string {
    const totalSeconds = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
