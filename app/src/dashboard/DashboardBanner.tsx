import { CloudOff, TriangleAlert } from 'lucide-react';
import type { DashboardBannerState } from './dashboardState.js';

/**
 * The one banner above the status strip.
 *
 * Its region is also where `auth.error` finally lands. That message has existed
 * since the auth package and had nowhere to go once the user was signed in —
 * it was a string the shell simply dropped. This is the surface the handoff
 * reserves for it, and it is the right one: a sign-in problem inside a working
 * shell is exactly the class of thing that belongs in a banner rather than a
 * full-page wall over a bot that is still answering.
 */

export interface DashboardBannerProps {
    state: DashboardBannerState;
    onAction?: (() => void) | undefined;
    /** Set while the action is in flight, so it cannot be fired twice. */
    pending?: boolean;
}

export function DashboardBanner({
    state,
    onAction,
    pending = false
}: DashboardBannerProps): React.JSX.Element {
    // Clay for the two states the user must act on; neutral for the one that is
    // about us rather than them. There is no separate error red in this system.
    const warning = state.kind !== 'unreachable';

    return (
        <div
            className={`banner ${warning ? 'banner--warning' : 'banner--neutral'}`}
            role="status"
            data-banner={state.kind}
        >
            <span className="banner__icon">
                {state.kind === 'unreachable'
                    ? <CloudOff size={18} aria-hidden="true" />
                    : <TriangleAlert size={18} aria-hidden="true" />}
            </span>

            <span className="banner__text">
                <span className="banner__title">{state.title}</span>
                <span className="banner__description">{state.description}</span>
            </span>

            {state.action && (
                <button
                    type="button"
                    className={`button ${state.kind === 'needs_reauth' ? 'button--primary' : 'button--ghost'}`}
                    onClick={onAction}
                    disabled={pending || !onAction}
                >
                    {state.action}
                </button>
            )}
        </div>
    );
}
