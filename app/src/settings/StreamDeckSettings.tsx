import { useState } from 'react';
import { Copy, Shield, Trash2 } from 'lucide-react';
import type { ApiKeySummary, CreatedApiKey } from '@almosthadai/shared';
import { apiRequest } from '../api/client.js';
import { withFreshSession, type SessionStorage } from '../auth/sessionStore.js';
import { useCollection, jsonRequest } from '../content/useCollection.js';
import { presentError } from '../content/errorPresentation.js';
import { ContentBanner } from '../content/ContentBanner.js';
import { validateApiKeyName } from '../content/validation.js';
import { formatShortDate } from '../songs/songsFormat.js';

/**
 * The Stream Deck settings pane, and the show-once key moment.
 *
 * The key is rendered in exactly one place and only while that place is open.
 * `POST /api/v1/api-keys` is the only response that has ever contained it and
 * there is no route that would return it again, so the modal below is not merely
 * the place the app chooses to show it. It is the only place the value exists.
 * Closing the modal discards it, which is why the copy says so plainly rather
 * than trusting the streamer to infer it from a missing column.
 *
 * The state holding it is deliberately the modal's own and is cleared on every
 * exit from it, so no path (closing, canceling, or creating a second key)
 * leaves a secret in a variable something could later render. The pinning
 * test for this asserts the negative: after the modal closes, the key text is not
 * on the screen and cannot be brought back.
 */

export interface StreamDeckSettingsProps {
    storage: SessionStorage;
}

export function StreamDeckSettings({ storage }: StreamDeckSettingsProps): React.JSX.Element {
    const keys = useCollection<ApiKeySummary>({ path: '/api/v1/api-keys', storage });

    const [naming, setNaming] = useState(false);
    const [name, setName] = useState('');
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    /** The one and only copy of a new key. Never persisted, never re-fetchable. */
    const [created, setCreated] = useState<CreatedApiKey | null>(null);
    const [copied, setCopied] = useState(false);

    const closeNaming = (): void => {
        setNaming(false);
        setName('');
        setFieldError(null);
    };

    /**
     * Leaving the show-once modal.
     *
     * Clearing `created` is the discard, because nowhere else holds the secret,
     * so this one line is the whole of "closing it discards it". The new row still
     * appears in the table underneath, because a key you cannot see is still a key
     * you need to be able to revoke.
     */
    const dismissCreated = (): void => {
        setCreated(null);
        setCopied(false);
        void keys.reload();
    };

    const create = (): void => {
        setFieldError(null);

        const check = validateApiKeyName(name);
        if (!check.ok) { setFieldError(check.message); return; }

        setBusy(true);
        void (async () => {
            try {
                const key = await withFreshSession(storage, (accessToken) =>
                    apiRequest<CreatedApiKey>('/api/v1/api-keys', {
                        method: 'POST',
                        body: { name: check.value },
                        accessToken
                    }));

                closeNaming();
                setCreated(key);
            } catch (error) {
                const presented = presentError(error);
                // A name conflict or a too-long name belongs on the field; the
                // rest is the collection's banner.
                if (presented.placement === 'field') setFieldError(presented.message);
                else setFieldError(presented.message);
            } finally {
                setBusy(false);
            }
        })();
    };

    const revoke = (key: ApiKeySummary): void => {
        void keys.mutate(
            (current) => current.filter((k) => k.id !== key.id),
            jsonRequest(`/api/v1/api-keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' }),
            { totalDelta: -1, treatGoneAsDone: true }
        );
    };

    return (
        <>
            {keys.banner && <ContentBanner message={keys.banner} onDismiss={keys.dismissBanner} />}

            <section className="card list-card">
                <header className="card__header">
                    <h2 className="card__title">Keys</h2>
                    <button
                        type="button"
                        className="button button--primary button--small"
                        onClick={() => { setNaming(true); }}
                    >
                        New key
                    </button>
                </header>

                {keys.items.length === 0
                    ? (
                        <div className="empty-panel">
                            <span className="empty-panel__glyph" aria-hidden="true">
                                <Shield size={16} />
                            </span>
                            <p className="empty-panel__copy">
                                No keys yet. Make one to drive the queue from a Stream Deck button.
                            </p>
                        </div>
                    )
                    : (
                        <>
                            <div className="list-grid list-grid--keys list-grid__head">
                                <span>NAME</span>
                                <span>KEY</span>
                                <span>MADE</span>
                                <span>LAST USED</span>
                                <span />
                            </div>
                            {keys.items.map((key) => (
                                <div className="list-grid list-grid--keys list-row" key={key.id}>
                                    <span className="list-row__cell">{key.name}</span>
                                    {/*
                                      * The prefix, which is all the server keeps.
                                      * The ellipsis is the point: it says this is
                                      * a fragment for recognizing a key, not a key.
                                      */}
                                    <span className="list-row__name">{key.prefix}...</span>
                                    <span className="list-row__cell">
                                        {formatShortDate(key.createdAt) ?? '-'}
                                    </span>
                                    {/* "never" rather than a dash: a key nothing
                                        has used is worth noticing, because it is
                                        the one that is safe to revoke. */}
                                    <span className="list-row__cell">
                                        {key.lastUsedAt ? formatShortDate(key.lastUsedAt) : 'never'}
                                    </span>
                                    <span className="list-row__actions">
                                        <button
                                            type="button"
                                            aria-label={`Revoke ${key.name}`}
                                            onClick={() => { revoke(key); }}
                                        >
                                            <Trash2 size={15} />
                                        </button>
                                    </span>
                                </div>
                            ))}
                        </>
                    )}

                <div className="card__footer card__footer--shield">
                    <Shield size={14} aria-hidden="true" />
                    A key can see the queue, skip a track, and turn requests on or off. That is the
                    whole list. It cannot touch commands, quotes or your numbers, so taping one
                    inside a Stream Deck profile is fine.
                </div>
            </section>

            {naming && (
                <div className="modal-scrim">
                    <div className="modal" role="dialog" aria-label="New key">
                        <h2 className="modal__title">Name this key</h2>
                        <label className="field">
                            <span className="field__label">NAME</span>
                            <input
                                className={`field__input${fieldError ? ' field__input--invalid' : ''}`}
                                value={name}
                                placeholder="Stream Deck"
                                aria-label="Key name"
                                autoFocus
                                onChange={(e) => { setName(e.target.value); setFieldError(null); }}
                            />
                        </label>
                        <p className="field__hint">
                            The name is the only way to tell your keys apart afterwards.
                        </p>
                        {fieldError && <p className="field__error">{fieldError}</p>}
                        <div className="modal__actions">
                            <button type="button" className="button button--text" onClick={closeNaming}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="button button--primary"
                                disabled={busy}
                                onClick={create}
                            >
                                Make key
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {created && (
                <div className="modal-scrim">
                    <div className="modal" role="dialog" aria-label="Copy this now">
                        <h2 className="modal__title">Copy this now</h2>
                        <p className="modal__copy">
                            This is the only time you will see it. Close this and it is gone for
                            good, and you would have to make a new one.
                        </p>
                        <code className="key-reveal">{created.key}</code>
                        <div className="modal__actions">
                            <button
                                type="button"
                                className="button button--primary"
                                onClick={() => {
                                    /*
                                     * Best effort, and the key stays on screen
                                     * either way. A webview without clipboard
                                     * permission must not swallow the one moment
                                     * the value exists, so a failed copy leaves
                                     * the streamer able to select it by hand
                                     * rather than closing the modal on them.
                                     */
                                    void navigator.clipboard?.writeText(created.key)
                                        .then(() => { setCopied(true); })
                                        .catch(() => { setCopied(false); });
                                }}
                            >
                                <Copy size={15} aria-hidden="true" />
                                {copied ? 'Copied' : 'Copy'}
                            </button>
                            <button type="button" className="button button--ghost" onClick={dismissCreated}>
                                Done
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
