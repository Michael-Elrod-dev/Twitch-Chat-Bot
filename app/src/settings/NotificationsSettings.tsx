import { useState } from 'react';
import { Check } from 'lucide-react';
import type { ChannelSettings, ManagedReward } from '@almosthadai/shared';
import type { SessionStorage } from '../auth/sessionStore.js';
import { useResource } from '../api/useResource.js';
import { validateWebhookUrl } from '../content/validation.js';
import { SettingRow } from '../controls/SettingRow.js';
import type { SettingsPatch } from './settingsPatch.js';

/**
 * The Notifications settings pane.
 *
 * **The webhook is write-only, and this component cannot break that promise even
 * if it tried.** There is no stored URL in the client to render: `ChannelSettings`
 * carries `discordWebhookConfigured`, a boolean, and the API has no route that
 * would return the value. So "never render the stored URL" is a property of the
 * contract rather than a rule this file remembers, which is the only version of
 * that rule worth having, because a URL is a capability and echoing one back
 * would let a stolen token exfiltrate it.
 *
 * Replace and Clear, and no Edit, for the same reason. You cannot edit a value you
 * cannot see; offering a field pre-filled with anything would either be a lie or a
 * leak.
 */

const REWARD_LABELS: Record<ManagedReward['kind'], string> = {
    song_request: 'Song Request',
    skip_queue: 'Skip the queue',
    add_quote: 'Add a quote'
};

export interface NotificationsSettingsProps {
    storage: SessionStorage;
    settings: ChannelSettings | null;
    onSettingsChange: (patch: SettingsPatch) => Promise<string | null>;
}

export function NotificationsSettings({
    storage,
    settings,
    onSettingsChange
}: NotificationsSettingsProps): React.JSX.Element {
    const rewards = useResource<{ items: ManagedReward[] }>({ path: '/api/v1/rewards', storage });

    const [replacing, setReplacing] = useState(false);
    const [draft, setDraft] = useState('');
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);

    const configured = settings?.discordWebhookConfigured ?? false;

    const save = (): void => {
        setFieldError(null);
        setSaved(false);

        const check = validateWebhookUrl(draft);
        if (!check.ok) { setFieldError(check.message); return; }

        setBusy(true);
        void (async () => {
            const error = await onSettingsChange({ discordWebhookUrl: check.value });
            setBusy(false);
            if (error !== null) { setFieldError(error); return; }

            // Cleared from local state the instant it is accepted. It only ever
            // existed here as something the user was typing; keeping it in a
            // closed form's state would leave a webhook URL sitting in the
            // renderer for the rest of the session.
            setDraft('');
            setReplacing(false);
            setSaved(true);
        })();
    };

    const clear = (): void => {
        setFieldError(null);
        setSaved(false);
        setBusy(true);
        void (async () => {
            // Explicit null clears it; `undefined` would mean "not mentioned" and
            // leave the webhook in place, as the contract's note on the field says.
            const error = await onSettingsChange({ discordWebhookUrl: null });
            setBusy(false);
            if (error !== null) setFieldError(error);
            else { setDraft(''); setReplacing(false); }
        })();
    };

    const items = rewards.data?.items ?? [];
    const bound = items.filter((reward) => reward.bound).length;

    return (
        <>
            <section className="card">
                <header className="card__header">
                    <h2 className="card__title">Discord go-live ping</h2>
                </header>

                <SettingRow
                    title="Webhook"
                    description={configured
                        ? 'Set. It is never shown back to you, because it is a key rather than a setting, so replacing is the only edit.'
                        : 'Not set. Paste a Discord webhook URL and the bot posts there when you go live.'}
                    footer={saved
                        ? <p className="setting-row__confirm">Saved. The next time you go live, Discord hears about it.</p>
                        : undefined}
                >
                    {replacing
                        ? null
                        : (
                            <span className="setting-row__actions">
                                <button
                                    type="button"
                                    className="button button--ghost"
                                    onClick={() => { setReplacing(true); setSaved(false); }}
                                >
                                    {configured ? 'Replace' : 'Set'}
                                </button>
                                {configured && (
                                    <button
                                        type="button"
                                        className="button button--danger"
                                        disabled={busy}
                                        onClick={clear}
                                    >
                                        Clear
                                    </button>
                                )}
                            </span>
                        )}
                </SettingRow>

                {replacing && (
                    <div className="setting-row setting-row--field">
                        <label className="field">
                            <span className="field__label">New webhook URL</span>
                            <input
                                className={`field__input field__input--mono${fieldError ? ' field__input--invalid' : ''}`}
                                value={draft}
                                placeholder="https://discord.com/api/webhooks/..."
                                aria-label="New webhook URL"
                                onChange={(e) => { setDraft(e.target.value); setFieldError(null); }}
                            />
                        </label>
                        <button
                            type="button"
                            className="button button--text"
                            onClick={() => { setReplacing(false); setDraft(''); setFieldError(null); }}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="button button--primary"
                            disabled={busy}
                            onClick={save}
                        >
                            Save
                        </button>
                    </div>
                )}

                {fieldError && <p className="field__error">{fieldError}</p>}
            </section>

            <section className="card">
                <header className="card__header">
                    <h2 className="card__title">Channel-point rewards the bot runs</h2>
                    {/*
                      * How many of the three are bound, never "3 of yours
                      * untouched", which the design draws. That number would be a
                      * count of the streamer's own rewards, and the API
                      * deliberately never enumerates them: the whole trust claim
                      * below rests on us not looking. Counting what we manage is
                      * the honest version of the same reassurance.
                      */}
                    <span className="card__meta">{bound} of {items.length} bound</span>
                </header>

                {items.map((reward) => (
                    <SettingRow key={reward.kind} title={reward.title ?? REWARD_LABELS[reward.kind]}>
                        {reward.bound
                            ? (
                                <span className="reward-state">
                                    <Check size={14} aria-hidden="true" />
                                    Bound
                                </span>
                            )
                            // Not an error and not a warning: a reward kind with
                            // nothing bound is a feature the channel is not using.
                            : <span className="reward-state reward-state--off">Not set up</span>}
                    </SettingRow>
                ))}

                <div className="card__footer">
                    These three are the only rewards the bot creates or edits. Anything else on
                    your channel it will not touch, ever.
                </div>
            </section>
        </>
    );
}
