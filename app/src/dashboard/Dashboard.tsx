import type { ChannelSettings, ChannelSummary, DashboardSummary, LiveChatMessage, QueuedSong } from '@almosthadai/shared';
import type { ConnectionState } from '../live/connection.js';
import { StatusStrip } from './StatusStrip.js';
import { NumbersRow } from './NumbersRow.js';
import { ChatCard } from './ChatCard.js';
import { SongQueueCard } from './SongQueueCard.js';
import { DashboardBanner } from './DashboardBanner.js';
import {
    formatLastStream,
    isServerReachable,
    resolveBanner,
    resolveNumbers,
    resolveStatusTiles
} from './dashboardState.js';

/**
 * The dashboard, in all four of its states.
 *
 * `2a` live, `2b` offline, `4a` needs-reauth and `4b` server-unreachable are
 * one screen, not four: the same skeleton with different readings. Building
 * them as separate components would have let them drift, and the whole point of
 * `4b` is that it is the same dashboard being honest about what it cannot see.
 */

/**
 * The empty copy, which is the entire message in three different situations.
 *
 * Written out rather than generated, because each sentence is doing specific
 * work: the live one is optimistic, the reauth one points at the fix, and the
 * unreachable one refuses to promise a backfill that is never coming.
 */
const CHAT_EMPTY = {
    live: 'Nobody\'s here. This fills up the second you go live.',
    needsReauth: 'Nothing is coming through while Twitch has the bot locked out.',
    unreachable: 'We are not receiving chat right now. Lines missed while we are disconnected stay missed.'
} as const;

const QUEUE_EMPTY = {
    live: 'Empty. Songs land here when someone burns points on the reward.',
    needsReauth: 'The reward cannot be redeemed while Twitch has the bot locked out.',
    unreachable: 'We cannot see the queue from here.'
} as const;

export interface DashboardProps {
    channel: ChannelSummary | null;
    settings: ChannelSettings | null;
    connection: ConnectionState;
    /** Null until the summary loads, or whenever we cannot reach the server. */
    summary: DashboardSummary | null;
    /** From the most recent `channel.status`; seeded by the summary on load. */
    live: boolean;
    /** `2:14:07`, already formatted and ticking. */
    uptime?: string | undefined;
    messages: LiveChatMessage[];
    queue: QueuedSong[];
    /** The sign-in error that had no home in the signed-in shell until now. */
    authError?: string | null;
    onReconnect?: (() => void) | undefined;
    onRetry?: (() => void) | undefined;
}

export function Dashboard({
    channel,
    settings,
    connection,
    summary,
    live,
    uptime,
    messages,
    queue,
    authError = null,
    onReconnect,
    onRetry
}: DashboardProps): React.JSX.Element {
    const inputs = { connection, channel, live, settings };
    const reachable = isServerReachable(inputs);
    const revoked = channel?.status === 'needs_reauth';

    const banner = resolveBanner({ ...inputs, authError });
    const tiles = resolveStatusTiles(inputs);
    /*
     * One guard, not two.
     *
     * `unknown` below is what decides whether a figure is rendered at all, so
     * an additional `reachable ?` here would be redundant — and redundancy that
     * no test can distinguish from the real guard is worse than none, because
     * it reads like protection while contributing nothing. Null figures mean
     * "not loaded yet"; `unknown` means "cannot see the server".
     */
    const cards = resolveNumbers(summary?.numbers ?? null);

    const chatEmpty = !reachable
        ? CHAT_EMPTY.unreachable
        : revoked ? CHAT_EMPTY.needsReauth : CHAT_EMPTY.live;
    const queueEmpty = !reachable
        ? QUEUE_EMPTY.unreachable
        : revoked ? QUEUE_EMPTY.needsReauth : QUEUE_EMPTY.live;

    return (
        <div className="dashboard">
            {banner && (
                <DashboardBanner
                    state={banner}
                    onAction={banner.kind === 'needs_reauth' ? onReconnect : onRetry}
                />
            )}

            <StatusStrip tiles={tiles} />

            <NumbersRow
                cards={cards}
                unknown={!reachable}
                // The caption belongs to the offline screen, where the figures
                // below it describe a stream that has ended and would otherwise
                // read as today's.
                lastStreamCaption={!live ? formatLastStream(summary?.lastStream ?? null) : null}
            />

            <div className="dashboard__bottom">
                <ChatCard
                    messages={reachable ? messages : []}
                    connection={connection === 'open' ? 'open' : connection === 'reconnecting' ? 'reconnecting' : 'down'}
                    broadcasterLogin={channel?.login.toLowerCase() ?? null}
                    emptyCopy={chatEmpty}
                />
                <SongQueueCard
                    queue={queue}
                    offline={!live}
                    requestsEnabled={settings?.songRequestsEnabled ?? false}
                    unknown={!reachable}
                    revoked={revoked}
                    emptyCopy={queueEmpty}
                />
            </div>

            {/* The uptime lives in the header pill; rendered here only so the
                screen has an accessible statement of it for a reader that never
                reaches the chrome. */}
            {uptime && <span className="sr-only">Live for {uptime}</span>}
        </div>
    );
}
