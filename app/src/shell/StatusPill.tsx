import { TriangleAlert } from 'lucide-react';
import type { PillState } from './channelStatus.js';

/**
 * The channel status pill, in all four of its states.
 *
 * `UNKNOWN` is not a decorative fallback. It is the honest answer whenever the
 * app cannot see the server, and it is deliberately worded so nobody mistakes
 * it for "offline".
 */

export interface StatusPillProps {
    state: PillState;
    /** `2:14:07`, already formatted. Only read in the live state. */
    uptime?: string | undefined;
}

export function StatusPill({ state, uptime }: StatusPillProps): React.JSX.Element {
    if (state === 'live') {
        return (
            <span className="pill pill--live" data-state="live">
                <span className="dot dot--live" aria-hidden="true" />
                LIVE{uptime ? ` ${uptime}` : ''}
            </span>
        );
    }

    if (state === 'needs_reauth') {
        return (
            <span className="pill pill--needs-reauth" data-state="needs_reauth">
                <TriangleAlert size={12} aria-hidden="true" />
                NEEDS RECONNECT
            </span>
        );
    }

    if (state === 'offline') {
        return (
            <span className="pill pill--offline" data-state="offline">
                <span className="dot dot--hollow" aria-hidden="true" />
                OFFLINE
            </span>
        );
    }

    return (
        <span className="pill pill--unknown" data-state="unknown">
            <span className="dot dot--hollow" aria-hidden="true" />
            UNKNOWN
        </span>
    );
}
