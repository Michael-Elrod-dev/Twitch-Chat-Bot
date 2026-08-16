import { KeyRound, Loader } from 'lucide-react';
import { APP_VERSION } from '../api/config.js';

/**
 * `5d` — waiting for the browser.
 *
 * The same frame as `3g` with the glyph pulsing, so the transition reads as one
 * screen continuing rather than two screens swapping. "Open the tab again"
 * exists because the browser tab is easy to lose behind a game.
 */

export interface WaitingProps {
    onReopen: () => void;
    onCancel: () => void;
    error?: string | null;
}

export function Waiting({ onReopen, onCancel, error = null }: WaitingProps): React.JSX.Element {
    return (
        <div className="auth">
            <div className="auth__panel">
                <span className="auth__glyph auth__glyph--pulsing" aria-hidden="true">
                    <KeyRound size={20} />
                </span>

                <h1 className="auth__headline">Finish up in your browser</h1>

                {error && <p className="auth__error" role="alert">{error}</p>}

                <div className="auth__waiting" role="status">
                    <Loader size={15} aria-hidden="true" />
                    Waiting for Twitch…
                </div>

                <div className="auth__actions">
                    <button type="button" className="button button--accent-text" onClick={onReopen}>
                        Open the tab again
                    </button>
                    <button type="button" className="button button--text" onClick={onCancel}>
                        Cancel
                    </button>
                </div>
            </div>

            <span className="auth__version">{APP_VERSION}</span>
        </div>
    );
}
