import { Check } from 'lucide-react';
import { APP_VERSION } from '../api/config.js';

/**
 * `3h` — connect the channel.
 *
 * Reached when someone is signed in but has no channel connected, which is an
 * ordinary state rather than an error (`/me` returns `channel: null` for it).
 *
 * The five scopes are spelled out in plain language on purpose. Twitch's own
 * consent screen shows its internal scope names; a broadcaster deserves to know
 * what they are agreeing to before they get there, in words they can check
 * against what the bot actually does.
 */

interface ScopeRow {
    name: string;
    reason: string;
}

const SCOPES: ScopeRow[] = [
    { name: 'Read chat', reason: 'So the bot can see commands and messages as they arrive.' },
    { name: 'Send chat', reason: 'So it can answer in your channel, as itself.' },
    { name: 'Channel points', reason: 'So song requests can be redeemed and refunded when they fail.' },
    { name: 'Stream status', reason: 'So it knows when you go live and when a stream ends.' },
    { name: 'Followers', reason: 'So it can tell a new follower apart from a regular.' }
];

export interface OnboardingProps {
    login: string;
    onConnect: () => void;
    busy?: boolean;
    error?: string | null;
}

export function Onboarding({
    login,
    onConnect,
    busy = false,
    error = null
}: OnboardingProps): React.JSX.Element {
    return (
        <div className="auth">
            <div className="auth__panel auth__panel--wide">
                <span className="channel-chip">
                    <span className="channel-chip__avatar" aria-hidden="true" />
                    {login}
                </span>

                <h1 className="auth__headline">One more handshake and the bot is yours</h1>

                {error && <p className="auth__error" role="alert">{error}</p>}

                <ul className="scopes">
                    {SCOPES.map((scope) => (
                        <li className="scopes__row" key={scope.name}>
                            <span className="scopes__check" aria-hidden="true">
                                <Check size={15} />
                            </span>
                            <span className="scopes__name">{scope.name}</span>
                            <span className="scopes__reason">{scope.reason}</span>
                        </li>
                    ))}
                </ul>

                <div className="auth__actions">
                    <button
                        type="button"
                        className="button button--primary button--block"
                        onClick={onConnect}
                        disabled={busy}
                    >
                        Connect my channel
                    </button>
                </div>

                <p className="auth__explainer">
                    Channel points rewards you made yourself are never touched — the bot
                    creates and manages only its own.
                </p>
            </div>

            <span className="auth__version">{APP_VERSION}</span>
        </div>
    );
}
