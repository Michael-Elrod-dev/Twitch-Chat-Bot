import { useState } from 'react';
import type { AiLimits, ChannelSettings } from '@almosthadai/shared';
import { SettingRow } from '../controls/SettingRow.js';
import { Toggle } from '../controls/Toggle.js';
import { Stepper } from '../controls/Stepper.js';
import { AI_LIMIT_MAX, AI_LIMIT_MIN } from '../content/validation.js';
import { USER_LEVEL_LABELS } from '../content/commandCatalog.js';
import type { SettingsPatch } from './settingsPatch.js';

/**
 * The AI settings pane.
 *
 * The whole set is sent, never the one tier that moved. A stepper changes one
 * number and this sends all four, because the contract accepts nothing else. The
 * reason is in the schema's own note. Merging a partial server-side would
 * resolve two people editing different tiers at once to whichever request landed
 * second, with the other tier's change lost inside a body that never mentioned
 * it. The screen already holds all four, so sending them costs nothing.
 *
 * The broadcaster is a word, not a stepper. They are unlimited, and a field for
 * it would exist only so that somebody could one day set it to three by
 * accident. The contract has no column for it either, as `AiLimits` shows.
 */

/**
 * The four editable tiers, in the order the design lists them.
 *
 * `subscriber` is drawn as "Subs" rather than borrowed from `USER_LEVEL_LABELS`,
 * which has no entry for it: that map labels the WHO chips on a command, and a
 * command's level is `everyone | vip | mod | broadcaster`. Two different sets of
 * tiers, deliberately not forced into one type, because a command cannot be
 * subscriber-only and an AI budget cannot belong to the broadcaster.
 */
const TIERS: { key: keyof AiLimits; label: string }[] = [
    { key: 'everyone', label: USER_LEVEL_LABELS.everyone },
    { key: 'vip', label: USER_LEVEL_LABELS.vip },
    { key: 'subscriber', label: 'Subs' },
    { key: 'moderator', label: USER_LEVEL_LABELS.mod }
];

export interface AiSettingsProps {
    settings: ChannelSettings | null;
    onSettingsChange: (patch: SettingsPatch) => Promise<string | null>;
}

export function AiSettings({ settings, onSettingsChange }: AiSettingsProps): React.JSX.Element {
    const [notice, setNotice] = useState<string | null>(null);

    const limits = settings?.aiLimits ?? null;

    const setLimit = (tier: keyof AiLimits, value: number): void => {
        if (!limits) return;
        setNotice(null);
        // Clamped here as well as at the buttons: a stepper held down at the
        // ceiling must not send a value the schema will refuse, which would turn
        // a fat finger into a red field.
        const next: AiLimits = {
            ...limits,
            [tier]: Math.min(AI_LIMIT_MAX, Math.max(AI_LIMIT_MIN, value))
        };

        void (async () => {
            const error = await onSettingsChange({ aiLimits: next });
            if (error !== null) setNotice(error);
        })();
    };

    return (
        <>
            <section className="card">
                <header className="card__header">
                    <h2 className="card__title">AI replies</h2>
                </header>
                <SettingRow
                    title="Let the bot answer"
                    description="Replies when someone says its name, plus !advice and !roast. Commands always win over a mention."
                >
                    <Toggle
                        on={settings?.aiEnabled ?? false}
                        label="Let the bot answer"
                        onChange={(next) => {
                            setNotice(null);
                            void (async () => {
                                const error = await onSettingsChange({ aiEnabled: next });
                                if (error !== null) setNotice(error);
                            })();
                        }}
                    />
                </SettingRow>
            </section>

            <section className="card">
                <header className="card__header">
                    <h2 className="card__title">Requests per viewer, per stream</h2>
                </header>

                {TIERS.map((tier) => (
                    <SettingRow key={tier.key} title={tier.label}>
                        <Stepper
                            value={limits?.[tier.key] ?? 0}
                            min={AI_LIMIT_MIN}
                            max={AI_LIMIT_MAX}
                            label={tier.label}
                            disabled={limits === null}
                            onChange={(next) => { setLimit(tier.key, next); }}
                        />
                    </SettingRow>
                ))}

                {/*
                  * The broadcaster's row, and the only one with no control. In
                  * sage rather than the body color because it is a reassurance
                  * rather than a setting: whatever the numbers above say, the
                  * streamer is never rationed in their own channel.
                  */}
                {/* "You" rather than `USER_LEVEL_LABELS.broadcaster` ("Just you"):
                    that map labels the WHO chips on a command, where the phrase
                    is answering "who can use it". Here it is a row heading in a
                    list of tiers, and the shorter word is what the design draws. */}
                <SettingRow title="You">
                    <span className="setting-row__unlimited">Unlimited</span>
                </SettingRow>

                {notice && <p className="inline-notice">{notice}</p>}
            </section>
        </>
    );
}
