import type { ChannelSettings, ChannelSummary, DashboardNumbers } from '@almosthadai/shared';
import type { ConnectionState } from '../live/connection.js';

/**
 * What the dashboard shows, decided in one place.
 *
 * Every rule the handoff states about the status strip lives here as a pure
 * function, for the same reason `channelStatus.ts` exists: this is where "our
 * link to the server" and "the state of the channel" meet, and therefore the
 * only place they could be conflated. The components below render what this
 * returns and make no decisions of their own.
 *
 * The rule that outranks everything: **when the server is unreachable we do not
 * know anything, and every tile says so.** Never zero, never "off" — a zero is
 * a claim about a bot that is very likely running perfectly well without us
 * watching, and it is the one lie this screen must not tell.
 */

export type TileId = 'session' | 'twitch' | 'spotify' | 'ai' | 'discord';

/**
 * How a tile's indicator reads.
 *
 * `healthy` is the sage dot running `okGlow`; `idle` is the same dot at reduced
 * opacity with no animation — on, but not busy; `dead` is the flat grey of
 * something switched off or never set up; `alert` is the pulsing clay of
 * something demanding action; `unknown` is not a dot at all but a `?`.
 */
export type TileDot = 'healthy' | 'idle' | 'dead' | 'alert' | 'unknown';

export interface StatusTile {
    id: TileId;
    label: string;
    value: string;
    dot: TileDot;
}

export interface DashboardInputs {
    connection: ConnectionState;
    /** Null while signed in with no channel connected. */
    channel: Pick<ChannelSummary, 'status' | 'enabled'> | null;
    /** From the most recent `channel.status`, or the dashboard summary on load. */
    live: boolean;
    settings: ChannelSettings | null;
}

/** Whether anything we believe about the channel is current. */
export function isServerReachable(inputs: Pick<DashboardInputs, 'connection'>): boolean {
    return inputs.connection === 'open';
}

const UNKNOWN_TILE = (id: TileId, label: string): StatusTile =>
    ({ id, label, value: 'Unknown', dot: 'unknown' });

/**
 * The five tiles, in the handoff's order.
 *
 * Read top to bottom: unreachable wins over everything, then Twitch having
 * revoked consent, then the owner's own switch, then live/offline. That order
 * is the point — each condition describes a world in which the ones below it
 * are unknowable, so checking them the other way round would show a confident
 * answer drawn from a stale one.
 */
export function resolveStatusTiles(inputs: DashboardInputs): StatusTile[] {
    const { channel, live, settings } = inputs;

    // `4b`. Not a fallback: the honest answer.
    if (!isServerReachable(inputs) || !channel) {
        return [
            UNKNOWN_TILE('session', 'SESSION'),
            UNKNOWN_TILE('twitch', 'TWITCH'),
            UNKNOWN_TILE('spotify', 'SPOTIFY'),
            UNKNOWN_TILE('ai', 'AI'),
            UNKNOWN_TILE('discord', 'DISCORD')
        ];
    }

    const revoked = channel.status === 'needs_reauth';
    // A channel that is streaming still has an idle bot if the bot is off or
    // locked out; "busy" is about the bot, not the broadcaster.
    const busy = live && !revoked && channel.enabled;
    /** Healthy while the bot is working, the same dot at rest when it is not. */
    const restingDot: TileDot = busy ? 'healthy' : 'idle';

    const session = ((): StatusTile => {
        // `4a`: Twitch has cut the bot off, so the session is dead whatever the
        // owner's switch says — showing "Off" here would blame the wrong thing.
        if (revoked) return { id: 'session', label: 'SESSION', value: 'Stopped', dot: 'dead' };
        // The owner's own choice, which the handoff's mocks never drew but the
        // master switch can produce at any moment.
        if (!channel.enabled) return { id: 'session', label: 'SESSION', value: 'Off', dot: 'dead' };
        return live
            ? { id: 'session', label: 'SESSION', value: 'Running', dot: 'healthy' }
            : { id: 'session', label: 'SESSION', value: 'Idle', dot: 'idle' };
    })();

    const twitch: StatusTile = revoked
        ? { id: 'twitch', label: 'TWITCH', value: 'Revoked', dot: 'alert' }
        : { id: 'twitch', label: 'TWITCH', value: 'Connected', dot: restingDot };

    const spotify: StatusTile = settings?.spotifyConnected
        ? { id: 'spotify', label: 'SPOTIFY', value: 'Connected', dot: restingDot }
        : { id: 'spotify', label: 'SPOTIFY', value: 'Not set up', dot: 'dead' };

    const ai = ((): StatusTile => {
        // Waiting, not off: the setting is still on and the bot will answer the
        // moment Twitch lets it back in.
        if (revoked) return { id: 'ai', label: 'AI', value: 'Waiting', dot: 'dead' };
        if (!settings?.aiEnabled) return { id: 'ai', label: 'AI', value: 'Off', dot: 'dead' };
        return busy
            ? { id: 'ai', label: 'AI', value: 'Answering', dot: 'healthy' }
            : { id: 'ai', label: 'AI', value: 'On', dot: 'idle' };
    })();

    const discord: StatusTile = settings?.discordWebhookConfigured
        ? { id: 'discord', label: 'DISCORD', value: 'Connected', dot: restingDot }
        : { id: 'discord', label: 'DISCORD', value: 'Not set up', dot: 'dead' };

    return [session, twitch, spotify, ai, discord];
}

/**
 * The stagger applied across the healthy dots so the row shimmers rather than
 * blinking in unison. Four delays across five tiles, per the handoff.
 */
const OK_GLOW_STAGGER = ['0s', '.45s', '.9s', '1.35s'];

export function okGlowDelay(index: number): string {
    return OK_GLOW_STAGGER[index % OK_GLOW_STAGGER.length] as string;
}

// ---- the numbers -----------------------------------------------------------

export interface NumberCard {
    id: keyof DashboardNumbers;
    /** Already grouped, or `?` when we cannot see the server. */
    figure: string;
    label: string;
}

const NUMBER_LABELS: { id: keyof DashboardNumbers; label: string }[] = [
    { id: 'messages', label: 'messages this stream' },
    { id: 'chatters', label: 'people talking' },
    { id: 'aiReplies', label: 'AI replies' },
    { id: 'pointsRedeemed', label: 'points redeemed' }
];

/**
 * @param numbers null when the server has not answered — which is NOT the same
 * as a channel that has streamed and scored zero. A zero means zero; a `?`
 * means we do not know, and conflating them tells a broadcaster their stream
 * was dead when in fact our socket was.
 */
export function resolveNumbers(numbers: DashboardNumbers | null): NumberCard[] {
    return NUMBER_LABELS.map(({ id, label }) => ({
        id,
        figure: numbers ? numbers[id].toLocaleString('en-US') : '?',
        label
    }));
}

/**
 * `Thursday · 4h 02m` — the offline screen's caption for the numbers below it.
 *
 * @returns null when the channel has never streamed, which is a different
 * state from a stream of zero length and gets the empty copy instead.
 */
export function formatLastStream(
    lastStream: { startedAt: string; endedAt: string | null } | null
): string | null {
    if (!lastStream) return null;

    const startedAt = new Date(lastStream.startedAt);
    if (Number.isNaN(startedAt.getTime())) return null;

    const day = startedAt.toLocaleDateString('en-US', { weekday: 'long' });
    if (!lastStream.endedAt) return day;

    const endedAt = new Date(lastStream.endedAt);
    if (Number.isNaN(endedAt.getTime())) return day;

    const minutes = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000));
    const hours = Math.floor(minutes / 60);

    return `${day} · ${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// ---- the banner ------------------------------------------------------------

export type BannerKind = 'needs_reauth' | 'unreachable' | 'error';

export interface DashboardBannerState {
    kind: BannerKind;
    title: string;
    description: string;
    action: string | null;
}

/**
 * The one banner above the strip, or none.
 *
 * Ordered by what the user can act on. An unreachable server outranks a revoked
 * token because the reconnect it would offer cannot be started while we cannot
 * reach the server that starts it — offering a button that must fail is worse
 * than saying plainly what is wrong.
 *
 * `authError` is the home the sign-in error never had inside the signed-in
 * shell: it arrived as a string with nowhere to go, and this is the region the
 * handoff reserves for exactly that class of message.
 */
export function resolveBanner(
    inputs: DashboardInputs & { authError?: string | null }
): DashboardBannerState | null {
    if (!isServerReachable(inputs)) {
        return {
            kind: 'unreachable',
            title: 'We cannot reach our server',
            description: 'Your bot is probably still running. We just cannot see it from here.',
            action: 'Retry now'
        };
    }

    if (inputs.channel?.status === 'needs_reauth') {
        return {
            kind: 'needs_reauth',
            title: 'Twitch cut the bot off',
            description: 'Reconnect your channel and everything picks up where it left off.',
            action: 'Reconnect Twitch'
        };
    }

    if (inputs.authError) {
        return {
            kind: 'error',
            title: 'Something went wrong signing in',
            description: inputs.authError,
            action: null
        };
    }

    return null;
}
