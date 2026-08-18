import { useState } from 'react';
import type { ChannelSettings, ChannelSummary } from '@almosthadai/shared';
import type { SessionStorage } from '../auth/sessionStore.js';
import { AiSettings } from './AiSettings.js';
import { SongsSettings } from './SongsSettings.js';
import { NotificationsSettings } from './NotificationsSettings.js';
import { StreamDeckSettings } from './StreamDeckSettings.js';
import { AccountSettings } from './AccountSettings.js';
import type { SettingsPatch } from './settingsPatch.js';

/**
 * Settings. The sub-nav and the five panes behind it.
 *
 * One page with a column of its own rather than five rail entries, because these
 * are things you set once and then forget: putting Notifications in the rail
 * beside Songs would give a five-minute-a-month screen the same weight as the one
 * the streamer looks at live.
 *
 * The panes each own their own data. The two that edit `ChannelSettings` go
 * through the shell, which owns `/me`. A pane holding its own copy would let the
 * AI toggle and the songs toggle disagree about the same object.
 */

export type SettingsPane = 'ai' | 'songs' | 'notifications' | 'streamdeck' | 'account';

const PANES: { id: SettingsPane; label: string }[] = [
    { id: 'ai', label: 'AI' },
    { id: 'songs', label: 'Songs' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'streamdeck', label: 'Stream Deck' },
    { id: 'account', label: 'Account' }
];

export interface SettingsProps {
    storage: SessionStorage;
    channel: ChannelSummary | null;
    settings: ChannelSettings | null;
    /** @returns null on success, or a message the pane places. */
    onSettingsChange: (patch: SettingsPatch) => Promise<string | null>;
    onSignOut: () => void;
    /** Tears the channel down. The pane behind it asks first. */
    onDisconnectChannel: () => Promise<string | null>;
    onConnectSpotify: () => void;
}

export function Settings({
    storage,
    channel,
    settings,
    onSettingsChange,
    onSignOut,
    onDisconnectChannel,
    onConnectSpotify
}: SettingsProps): React.JSX.Element {
    const [pane, setPane] = useState<SettingsPane>('ai');

    return (
        <div className="content-page">
            <header className="content-header">
                <h1 className="content-title">Settings</h1>
            </header>

            <div className="settings">
                <nav className="settings__nav" aria-label="Settings sections">
                    {PANES.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            aria-current={pane === option.id ? 'page' : undefined}
                            className={`settings__nav-item${pane === option.id ? ' settings__nav-item--on' : ''}`}
                            onClick={() => { setPane(option.id); }}
                        >
                            {option.label}
                        </button>
                    ))}
                </nav>

                <div className="settings__content">
                    {pane === 'ai' && (
                        <AiSettings settings={settings} onSettingsChange={onSettingsChange} />
                    )}
                    {pane === 'songs' && (
                        <SongsSettings
                            storage={storage}
                            settings={settings}
                            onSettingsChange={onSettingsChange}
                            onConnectSpotify={onConnectSpotify}
                        />
                    )}
                    {pane === 'notifications' && (
                        <NotificationsSettings
                            storage={storage}
                            settings={settings}
                            onSettingsChange={onSettingsChange}
                        />
                    )}
                    {pane === 'streamdeck' && <StreamDeckSettings storage={storage} />}
                    {pane === 'account' && (
                        <AccountSettings
                            channel={channel}
                            onSignOut={onSignOut}
                            onDisconnectChannel={onDisconnectChannel}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
