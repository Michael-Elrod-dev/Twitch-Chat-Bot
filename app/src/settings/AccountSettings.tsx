import { useState } from 'react';
import type { ChannelSummary } from '@almosthadai/shared';
import { APP_VERSION_NUMBER } from '../api/config.js';
import { SettingRow } from '../controls/SettingRow.js';

/**
 * Settings · Account (`5c`) — identity, the app's own version, and the danger
 * zone.
 *
 * **The danger zone is a separate card, and that is the design doing work.** It
 * is the only irreversible thing in the app that a mis-click could reach, so it
 * sits below everything else, in its own frame, with the consequences written out
 * before the button rather than in a dialog that appears after the decision.
 *
 * The confirmation is a second click on a control that has changed its own label,
 * not a modal. A modal for this would be dismissible by every reflex a person has
 * for dismissing modals; a button that now reads "Yes, disconnect" cannot be
 * agreed with by accident.
 *
 * **What the card promises, the server keeps — and the copy was changed to match
 * what it actually does.** It used to say the three rewards "go away", which read
 * as deletion and was implemented as deletion. Disconnect now switches them off
 * instead: nobody can redeem them, no points are taken, and the title, cost,
 * prompt and redemption history the streamer configured survive for a channel
 * they may reconnect. Two of the owner's own three predate this application
 * entirely, so deleting them reached further than the promise ever required. The
 * copy says "switched off" because that is the true thing, and a danger card that
 * overstates what it does is the last place to be loose with words.
 */

export interface AccountSettingsProps {
    channel: ChannelSummary | null;
    onSignOut: () => void;
    /** @returns null on success, or a message to place in the danger card. */
    onDisconnectChannel: () => Promise<string | null>;
}

export function AccountSettings({
    channel,
    onSignOut,
    onDisconnectChannel
}: AccountSettingsProps): React.JSX.Element {
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const disconnected = channel?.status === 'disconnected';

    const disconnect = (): void => {
        if (!confirming) { setConfirming(true); setError(null); return; }

        setBusy(true);
        void (async () => {
            const failure = await onDisconnectChannel();
            setBusy(false);
            setConfirming(false);
            setError(failure);
        })();
    };

    return (
        <>
            <section className="card identity-card">
                <span className="identity-card__avatar" aria-hidden="true" />
                <span className="identity-card__text">
                    <span className="identity-card__login">
                        {channel?.displayName ?? channel?.login ?? '—'}
                    </span>
                    {/*
                      * No "Channel connected 28 Jul" line, which the design draws.
                      * `ChannelSummary` carries no connected-at date and the
                      * contract wins; inventing one from the token's issue time
                      * would be a plausible number that is not the answer.
                      * Flagged for a future field rather than faked here.
                      */}
                    <span className="identity-card__meta">
                        {disconnected ? 'Channel disconnected' : 'Channel connected'}
                    </span>
                </span>
                <button type="button" className="button button--ghost" onClick={onSignOut}>
                    Sign out
                </button>
            </section>

            <section className="card">
                <header className="card__header">
                    <h2 className="card__title">App</h2>
                </header>
                <SettingRow
                    title={`Version ${APP_VERSION_NUMBER}`}
                    description="Updates install themselves when you next open the app."
                >
                    {/*
                      * `CURRENT` and nothing else. The design draws "Up to date"
                      * beside it, which is a claim about a check this app has not
                      * made: the Tauri updater runs at launch, and reporting its
                      * verdict needs a status this screen is not given. The chip
                      * says which version is running, which is true whatever the
                      * updater thinks.
                      */}
                    <span className="chip chip--builtin">CURRENT</span>
                </SettingRow>
            </section>

            <section className="card card--danger">
                <header className="card__header">
                    <h2 className="card__title">Danger</h2>
                </header>

                <SettingRow
                    title="Disconnect this channel"
                    description="The bot leaves chat, its three channel-point rewards are switched off, and it stops answering. Your rewards keep their settings, and your commands, emotes and quotes stay put in case you come back."
                    footer={confirming
                        ? (
                            <p className="setting-row__warn">
                                This cannot be undone from here — reconnecting means going through
                                Twitch again.
                            </p>
                        )
                        : undefined}
                >
                    <span className="setting-row__actions">
                        {confirming && (
                            <button
                                type="button"
                                className="button button--text"
                                onClick={() => { setConfirming(false); }}
                            >
                                Cancel
                            </button>
                        )}
                        <button
                            type="button"
                            className="button button--danger"
                            disabled={busy || disconnected}
                            onClick={disconnect}
                        >
                            {disconnected
                                ? 'Disconnected'
                                : confirming ? 'Yes, disconnect' : 'Disconnect'}
                        </button>
                    </span>
                </SettingRow>

                {error && <p className="field__error">{error}</p>}
            </section>
        </>
    );
}
