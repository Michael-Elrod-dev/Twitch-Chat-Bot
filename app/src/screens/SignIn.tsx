import { ExternalLink, KeyRound } from 'lucide-react';
import { APP_VERSION } from '../api/config.js';

/**
 * Sign in.
 *
 * No rail, no channel header: there is nothing to navigate to yet. The
 * reachability pill belongs on this screen specifically, because this is where
 * someone would first hit an unreachable server, and finding that out before
 * being bounced into a browser is the kinder order.
 */

export interface SignInProps {
    onSignIn: () => void;
    serverReachable: boolean | null;
    busy?: boolean;
    error?: string | null;
}

export function SignIn({
    onSignIn,
    serverReachable,
    busy = false,
    error = null
}: SignInProps): React.JSX.Element {
    return (
        <div className="auth">
            <div className="auth__panel">
                <span className="auth__glyph" aria-hidden="true">
                    <KeyRound size={20} />
                </span>

                <h1 className="auth__headline">Sign in to run your bot</h1>

                <p className="auth__explainer">
                    Twitch handles the sign-in in your browser. This app never sees your
                    password. It only receives permission to act in your channel, and you
                    can withdraw that from Twitch at any time.
                </p>

                {error && <p className="auth__error" role="alert">{error}</p>}

                <div className="auth__actions">
                    <button
                        type="button"
                        className="button button--primary button--block"
                        onClick={onSignIn}
                        disabled={busy}
                    >
                        <ExternalLink size={15} aria-hidden="true" />
                        Continue with Twitch
                    </button>
                </div>

                <ReachabilityPill reachable={serverReachable} />
            </div>

            <span className="auth__version">{APP_VERSION}</span>
        </div>
    );
}

function ReachabilityPill({ reachable }: { reachable: boolean | null }): React.JSX.Element {
    if (reachable === null) {
        return (
            <span className="auth__reach">
                <span className="dot dot--hollow" aria-hidden="true" />
                CHECKING
            </span>
        );
    }

    if (!reachable) {
        return (
            <span className="auth__reach">
                <span className="dot dot--hollow" aria-hidden="true" />
                SERVER UNREACHABLE
            </span>
        );
    }

    return (
        <span className="auth__reach">
            <span className="dot dot--healthy" aria-hidden="true" />
            SERVER REACHABLE
        </span>
    );
}
