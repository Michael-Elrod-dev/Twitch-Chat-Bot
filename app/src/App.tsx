import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
    ChannelEnabledResponse,
    DashboardSummary,
    LiveChatMessage,
    LiveEvent,
    MeResponse,
    QueuedSong
} from '@almosthadai/shared';
import { apiRequest } from './api/client.js';
import { API_BASE_URL } from './api/config.js';
import { useAuth } from './auth/useAuth.js';
import {
    freshAccessToken,
    withFreshSession,
    browserSessionStorage,
    type SessionStorage
} from './auth/sessionStore.js';
import { LiveConnection, type ConnectionState } from './live/connection.js';
import type { Platform } from './platform/tauri.js';
import { TitleBar } from './shell/TitleBar.js';
import { IconRail, type RailSection } from './shell/IconRail.js';
import { ChannelHeader } from './shell/ChannelHeader.js';
import { formatUptime } from './shell/channelStatus.js';
import { Dashboard } from './dashboard/Dashboard.js';
import { Commands } from './content/Commands.js';
import { Emotes } from './content/Emotes.js';
import { Quotes } from './content/Quotes.js';
import { appendChatMessage } from './dashboard/ChatCard.js';
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
    const [summary, setSummary] = useState<DashboardSummary | null>(null);
    const [messages, setMessages] = useState<LiveChatMessage[]>([]);
    const [queue, setQueue] = useState<QueuedSong[]>([]);

    const token = auth.accessToken;

    // ---- what is true right now --------------------------------------------

    /**
     * The dashboard's opening state, and the seed for the uptime clock.
     *
     * The realtime feed carries transitions; this carries the state they change.
     * An app opened mid-stream has missed every transition that ever happened,
     * so without this the uptime clock would not start until the broadcaster
     * went offline — which is exactly when it stops being interesting.
     */
    const loadDashboard = useCallback(async (): Promise<void> => {
        try {
            const [next, songs] = await Promise.all([
                withFreshSession(sessionStorage, (accessToken) =>
                    apiRequest<DashboardSummary>('/api/v1/dashboard', { accessToken })),
                withFreshSession(sessionStorage, (accessToken) =>
                    apiRequest<{ items: QueuedSong[]; total: number }>('/api/v1/songs', { accessToken }))
            ]);

            setSummary(next);
            setQueue(songs.items);
            setLive(next.live);
            setStreamStartedAt(next.startedAt ? new Date(next.startedAt) : null);
        } catch {
            /*
             * Cleared, not kept.
             *
             * Stale figures under a live-looking screen are worse than none: the
             * `4b` rule is that an unreachable server produces `?`, and holding
             * the last good numbers would quietly turn that into a confident
             * claim about a bot we can no longer see. The connection state is
             * what drives the banner; this just makes sure there is nothing left
             * to render behind it.
             */
            setSummary(null);
        }
    }, [sessionStorage]);

    // ---- realtime ----------------------------------------------------------

    useEffect(() => {
        if (auth.phase !== 'signed_in' || !token) return undefined;

        const connectionRef = new LiveConnection({
            // A fresh token per attempt, not the one captured at boot: tokens
            // live fifteen minutes and a socket that reconnects with an expired
            // one is refused silently, forever.
            token: () => freshAccessToken(sessionStorage),
            onStateChange: (state) => {
                setConnection(state);
                // Re-open means we have been away: whatever happened while the
                // socket was down arrived nowhere, so the state is re-read
                // rather than assumed to have survived.
                if (state === 'open') void loadDashboard();
            },
            onEvent: (event: LiveEvent) => {
                if (event.type === 'channel.status') {
                    setLive(event.live);
                    // Re-synced from the server on every status event; the tick
                    // below only fills in the seconds between them. Taken from
                    // `startedAt` and NOT from `at` — `at` is when the event was
                    // sent, so seeding from it would restart the clock at every
                    // status change and read minutes into an hours-long stream.
                    setStreamStartedAt(event.startedAt ? new Date(event.startedAt) : null);
                    // The numbers belong to a stream; when one starts or ends
                    // they are about a different stream than they were.
                    void loadDashboard();
                }

                if (event.type === 'chat.message') {
                    setMessages((current) => appendChatMessage(current, event));
                }

                if (event.type === 'song_queue.updated') {
                    // Refetched rather than applied: the event announces that
                    // the queue moved, and the payload does not carry it.
                    void withFreshSession(sessionStorage, (accessToken) =>
                        apiRequest<{ items: QueuedSong[]; total: number }>('/api/v1/songs', { accessToken }))
                        .then((songs) => { setQueue(songs.items); })
                        .catch(() => { /* the next status refresh picks it up */ });
                }
            }
        });

        connectionRef.start();
        return () => { connectionRef.stop(); };
    }, [auth.phase, token, loadDashboard, sessionStorage]);

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
                        {section === 'dashboard'
                            ? (
                                <Dashboard
                                    channel={auth.me.channel}
                                    settings={auth.me.settings}
                                    connection={connection}
                                    summary={summary}
                                    live={live}
                                    uptime={uptime}
                                    messages={messages}
                                    queue={queue}
                                    // The home this finally has. Until now a
                                    // sign-in error inside the signed-in shell
                                    // was a string with nowhere to go.
                                    authError={auth.error}
                                    onReconnect={connectChannel}
                                    onRetry={() => { void loadDashboard(); }}
                                />
                            )
                            : section === 'commands' ? <Commands storage={sessionStorage} />
                                : section === 'emotes' ? <Emotes storage={sessionStorage} />
                                    : section === 'quotes' ? <Quotes storage={sessionStorage} />
                                        /* 9c fills the rest in. */
                                        : <p style={{ color: 'var(--color-text-tertiary)' }}>{section}</p>}
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
