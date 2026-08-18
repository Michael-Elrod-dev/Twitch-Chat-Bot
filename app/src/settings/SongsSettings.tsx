import { useState } from 'react';
import type { ChannelSettings, SpotifyStatus } from '@almosthadai/shared';
import { apiRequest } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import { withFreshSession, type SessionStorage } from '../auth/sessionStore.js';
import { presentError } from '../content/errorPresentation.js';
import { validatePlaylistName } from '../content/validation.js';
import { SettingRow } from '../controls/SettingRow.js';
import { Toggle } from '../controls/Toggle.js';
import { SpotifyCard } from '../songs/SpotifyCard.js';
import type { SettingsPatch } from './settingsPatch.js';

/**
 * The Songs settings pane.
 *
 * The reward switch, the playlist, and the Spotify link in one place, which is
 * the point of the pane. All three are the same decision seen from three angles,
 * and a streamer who turns requests off wants to know in the same glance whether
 * the account behind them is even attached.
 *
 * **The name is saved explicitly, and the toggles are not.** A toggle is one bit
 * and its own confirmation: it moved, so it saved. A name is a thing you are
 * halfway through typing, and saving on every keystroke would have the server
 * resolving "S", then "St", then "Str" against Spotify and possibly creating a playlist
 * called `S`. Hence a Save button, and hence the sage line confirming what it did.
 */

export interface SongsSettingsProps {
    storage: SessionStorage;
    settings: ChannelSettings | null;
    onSettingsChange: (patch: SettingsPatch) => Promise<string | null>;
    onConnectSpotify: () => void;
}

export function SongsSettings({
    storage,
    settings,
    onSettingsChange,
    onConnectSpotify
}: SongsSettingsProps): React.JSX.Element {
    const spotify = useResource<SpotifyStatus>({ path: '/api/v1/spotify', storage });

    /**
     * Null while the field is untouched, so the input shows the saved name.
     *
     * A `useState(settings.requestsPlaylistName)` would freeze at whatever the
     * name was on first render and never follow a save, so the field would go stale
     * against the very value it just wrote.
     */
    const [draft, setDraft] = useState<string | null>(null);
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [saved, setSaved] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    const name = draft ?? settings?.requestsPlaylistName ?? '';
    const connected = spotify.data?.connected ?? false;

    const savePlaylistName = (): void => {
        setFieldError(null);
        setSaved(null);

        const check = validatePlaylistName(name);
        if (!check.ok) { setFieldError(check.message); return; }

        setBusy(true);
        void (async () => {
            // The schema's trimmed value, not the raw box: the server would trim
            // it anyway, and a client that sent the untrimmed string would show a
            // confirmation for a name it did not save.
            const error = await onSettingsChange({ requestsPlaylistName: check.value });
            setBusy(false);

            if (error !== null) { setFieldError(error); return; }

            setDraft(null);
            setSaved(check.value);
            // The playlist may have just been created at Spotify, so the card's
            // track count is out of date the moment this succeeds.
            await spotify.reload();
        })();
    };

    const disconnect = (): void => {
        setBusy(true);
        void (async () => {
            try {
                await withFreshSession(storage, (accessToken) =>
                    apiRequest('/api/v1/spotify', { method: 'DELETE', accessToken }));
            } catch (error) {
                setNotice(presentError(error).message);
            } finally {
                setBusy(false);
                await spotify.reload();
                // Requests are switched off with the account server-side, so the
                // shell's settings are stale. Re-read rather than assumed.
                await onSettingsChange({});
            }
        })();
    };

    const toggle = (patch: Partial<ChannelSettings>): void => {
        setNotice(null);
        void (async () => {
            const error = await onSettingsChange(patch);
            if (error !== null) setNotice(error);
        })();
    };

    return (
        <>
            <section className="card">
                <header className="card__header">
                    <h2 className="card__title">Requests</h2>
                </header>

                <SettingRow
                    title="Let viewers request songs"
                    description="Switches the Twitch reward itself off, so nobody can spend points on something the bot will not play."
                >
                    <Toggle
                        on={settings?.songRequestsEnabled ?? false}
                        label="Let viewers request songs"
                        // Same reasoning as the songs header: with no account
                        // linked, switching the reward on would sell viewers a
                        // request the bot cannot fulfill.
                        disabled={!connected}
                        onChange={(next) => { toggle({ songRequestsEnabled: next }); }}
                    />
                </SettingRow>

                <SettingRow
                    title="Save every request to a playlist"
                    description="Added once each, duplicates skipped. If the playlist does not exist yet, the bot makes it."
                >
                    <Toggle
                        on={settings?.requestsPlaylistEnabled ?? false}
                        label="Save every request to a playlist"
                        disabled={!connected}
                        onChange={(next) => { toggle({ requestsPlaylistEnabled: next }); }}
                    />
                </SettingRow>

                <div className="setting-row setting-row--field">
                    <label className="field">
                        <span className="field__label">Playlist</span>
                        <input
                            className={`field__input${fieldError ? ' field__input--invalid' : ''}`}
                            value={name}
                            placeholder="Stream Requests"
                            disabled={!connected || busy}
                            onChange={(e) => {
                                setDraft(e.target.value);
                                setFieldError(null);
                                setSaved(null);
                            }}
                        />
                    </label>
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={!connected || busy}
                        onClick={savePlaylistName}
                    >
                        Save
                    </button>
                </div>

                {fieldError && <p className="field__error">{fieldError}</p>}

                {/*
                  * The sage confirmation, and it says what actually happened
                  * rather than "Saved". `playlist` null after a successful save
                  * means Spotify has no playlist by that name yet, which is
                  * correct and expected, because the bot creates it with the
                  * first request rather than up front. Reporting a track count
                  * here would be reporting a playlist that does not exist.
                  */}
                {saved && !fieldError && (
                    <p className="setting-row__confirm">
                        {spotify.data?.playlist
                            ? `Saving requests to "${spotify.data.playlist.name}", ${spotify.data.playlist.trackCount} tracks in it.`
                            : `Saved. The bot makes "${saved}" with the first request.`}
                    </p>
                )}

                {notice && <p className="inline-notice">{notice}</p>}
            </section>

            {spotify.loading
                ? null
                : connected
                    ? (
                        <SpotifyCard
                            status={spotify.data as SpotifyStatus}
                            onDisconnect={disconnect}
                            disconnecting={busy}
                            explainer="Songs play through whatever device Spotify is already using."
                        />
                    )
                    : (
                        <section className="card spotify-card">
                            <span className="spotify-card__label">SPOTIFY</span>
                            <span className="spotify-card__reading">
                                <span className="dot dot--dead" aria-hidden="true" />
                                <span className="spotify-card__state spotify-card__state--off">
                                    Not connected
                                </span>
                            </span>
                            <p className="spotify-card__explainer">
                                Nothing song-related works until an account is linked. The reward
                                stays switched off until it is.
                            </p>
                            <button
                                type="button"
                                className="button button--primary button--block"
                                onClick={onConnectSpotify}
                            >
                                Connect Spotify
                            </button>
                        </section>
                    )}
        </>
    );
}
