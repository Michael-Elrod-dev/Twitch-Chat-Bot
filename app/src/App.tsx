import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChannelEnabledResponse, LiveEvent, MeResponse } from '@almosthadai/shared';
import { apiRequest } from './api/client.js';
import { API_BASE_URL } from './api/config.js';
import { useAuth } from './auth/useAuth.js';
import { withFreshSession, browserSessionStorage, type SessionStorage } from './auth/sessionStore.js';
import { LiveConnection, type ConnectionState } from './live/connection.js';
import type { Platform } from './platform/tauri.js';
import { TitleBar } from './shell/TitleBar.js';
import { IconRail, type RailSection } from './shell/IconRail.js';
import { ChannelHeader } from './shell/ChannelHeader.js';
import { formatUptime } from './shell/channelStatus.js';
import { SignIn } from './screens/SignIn.js';
import { Waiting } from './screens/Waiting.js';
import { Onboarding } from './screens/Onboarding.js';

/**
 * The application root.
 *
 * The title bar persists across every phase — including the auth screens, which
 * have no rail and no channel header but are still inside a window that has to
 * be movable and closable. Everything below it swaps.
 */

export interface AppProps {
    platform: Platform;
    storage?: SessionStorage;
}

export function App({ platform, storage }: AppProps): React.JSX.Element {
    const sessionStorage = useMemo(() => storage ?? browserSessionStorage(), [storage]);
    const auth = useAuth(platform, sessionStorage);

    const [section, setSection] = useState<RailSection>('dashboard');
    const [connection, setConnection] = useState<ConnectionState>('down');
    const [live, setLive] = useState(false);
    const [streamStartedAt, setStreamStartedAt] = useState<Date | null>(null);
    const [uptime, setUptime] = useState<string | undefined>(undefined);
    const [togglePending, setTogglePending] = useState(false);

    const token = auth.accessToken;

    // ---- realtime ----------------------------------------------------------

    useEffect(() => {
        if (auth.phase !== 'signed_in' || !token) return undefined;

        const connectionRef = new LiveConnection({
            accessToken: token,
            onStateChange: setConnection,
            onEvent: (event: LiveEvent) => {
                if (event.type === 'channel.status') {
                    setLive(event.live);
                    // Re-synced from the server on every status event; the tick
                    // below only fills in the seconds between them.
                    setStreamStartedAt(event.live ? new Date(event.at) : null);
                }
            }
        });

        connectionRef.start();
        return () => { connectionRef.stop(); };
    }, [auth.phase, token]);

    // The uptime clock ticks locally once a second.
    const startedAtRef = useRef<Date | null>(null);
    startedAtRef.current = streamStartedAt;

    useEffect(() => {
        if (!streamStartedAt) { setUptime(undefined); return undefined; }

        const tick = (): void => {
            const startedAt = startedAtRef.current;
            if (startedAt) setUptime(formatUptime(startedAt, new Date()));
        };

        tick();
        const handle = setInterval(tick, 1000);
        return () => { clearInterval(handle); };
    }, [streamStartedAt]);

    // ---- the master switch -------------------------------------------------

    const toggleBot = useCallback((next: boolean): void => {
        const current = auth.me;
        // Bound to a local: narrowing on a mutable property does not survive
        // into the async closure below.
        const channel = current?.channel;
        if (!current || !channel) return;

        // Optimistic: the control moves now, and rolls back if the server says
        // otherwise. A toggle that waits on a round trip reads as broken.
        const previous = channel.enabled;
        auth.setMe({ ...current, channel: { ...channel, enabled: next } });
        setTogglePending(true);

        void (async () => {
            try {
                const result = await withFreshSession(sessionStorage, (accessToken) =>
                    apiRequest<ChannelEnabledResponse>('/api/v1/me/channel', {
                        method: 'PATCH',
                        body: { enabled: next },
                        accessToken
                    }));

                // Both fields from one round trip — `status` is authoritative
                // and is NOT inferred from the switch we just moved.
                auth.setMe({
                    ...current,
                    channel: { ...channel, enabled: result.enabled, status: result.status }
                } satisfies MeResponse);
            } catch {
                auth.setMe({ ...current, channel: { ...channel, enabled: previous } });
            } finally {
                setTogglePending(false);
            }
        })();
    }, [auth, sessionStorage]);

    const [connectError, setConnectError] = useState<string | null>(null);

    const connectChannel = useCallback((): void => {
        // The channel grant is a second Twitch consent, in the system browser
        // like the first one — and, like the first one, a browser that fails to
        // open must say so rather than leaving a button that appears dead.
        setConnectError(null);
        void platform.openExternal(`${API_BASE_URL}/auth/twitch/connect`).catch((err: unknown) => {
            setConnectError(
                `Could not open your browser (${err instanceof Error ? err.message : String(err)}).`
            );
        });
    }, [platform]);

    // ---- render ------------------------------------------------------------

    const body = ((): React.JSX.Element => {
        if (auth.phase === 'loading') return <div className="auth" />;

        if (auth.phase === 'signed_out') {
            return (
                <SignIn
                    onSignIn={() => { void auth.beginSignIn(); }}
                    serverReachable={auth.serverReachable}
                    error={auth.error}
                />
            );
        }

        if (auth.phase === 'waiting') {
            return (
                <Waiting
                    onReopen={() => { void auth.reopenSignIn(); }}
                    onCancel={auth.cancelSignIn}
                    error={auth.error}
                />
            );
        }

        // Signed in, but Twitch has not been asked about the channel yet. An
        // ordinary state, not a failure.
        if (!auth.me?.channel) {
            return (
                <Onboarding
                    login={auth.me?.login ?? ''}
                    onConnect={connectChannel}
                    error={connectError ?? auth.error}
                />
            );
        }

        return (
            <div className="app__body">
                <IconRail active={section} onSelect={setSection} />
                <div className="app__content">
                    <ChannelHeader
                        channel={auth.me.channel}
                        connection={connection}
                        live={live}
                        uptime={uptime}
                        onToggleBot={toggleBot}
                        togglePending={togglePending}
                    />
                    <main className="content">
                        {/* WP9 fills these in; the shell around them is what this package owed. */}
                        <p style={{ color: 'var(--color-text-tertiary)' }}>{section}</p>
                    </main>
                </div>
            </div>
        );
    })();

    return (
        <div className="app">
            <TitleBar controls={platform.controls} />
            {body}
        </div>
    );
}
