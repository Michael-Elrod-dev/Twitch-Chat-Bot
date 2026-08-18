import type { SpotifyStatus } from '@almosthadai/shared';
import { formatShortDate } from './songsFormat.js';

/**
 * The Spotify link, as a card.
 *
 * Shared by the songs screen's right column and the songs settings pane's bottom
 * card, because it is the same card in both places. The design draws it twice
 * with different chrome around it, and building it twice is how
 * one of them ends up still offering Disconnect after the account is gone.
 *
 * There is nothing here that could authenticate, and that is a property of the
 * response rather than of this component's restraint: `SpotifyStatus` carries a
 * display name, a date and a track count. See the contract's note.
 */

export interface SpotifyCardProps {
    status: SpotifyStatus;
    onDisconnect: () => void;
    disconnecting?: boolean;
    /**
     * `5a` explains where the music comes out; `3c` does not have the room.
     * Absent means no explanatory line.
     */
    explainer?: string | undefined;
}

export function SpotifyCard({
    status,
    onDisconnect,
    disconnecting = false,
    explainer
}: SpotifyCardProps): React.JSX.Element {
    const since = formatShortDate(status.connectedSince);

    return (
        <section className="card spotify-card">
            <span className="spotify-card__label">SPOTIFY</span>

            <span className="spotify-card__reading">
                <span className={status.connected ? 'dot dot--healthy' : 'dot dot--dead'} aria-hidden="true" />
                <span className={status.connected ? 'spotify-card__state' : 'spotify-card__state spotify-card__state--off'}>
                    {status.connected ? 'Connected' : 'Not connected'}
                </span>
            </span>

            {status.connected && (
                <>
                    {status.accountName && (
                        <span className="spotify-card__account">{status.accountName}</span>
                    )}
                    {/* Null when the link predates us recording the date. Omitted
                        rather than rendered as "since unknown", which invites the
                        reader to wonder what else we have lost. */}
                    {since && <span className="spotify-card__since">since {since}</span>}
                    {explainer && <p className="spotify-card__explainer">{explainer}</p>}
                    <button
                        type="button"
                        className="button button--ghost button--block"
                        disabled={disconnecting}
                        onClick={onDisconnect}
                    >
                        Disconnect
                    </button>
                </>
            )}
        </section>
    );
}
