import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
    ChannelDisconnectedResponse,
    ChannelEnabledResponse,
    ChannelSettings,
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
import { Songs } from './songs/Songs.js';
import { Analytics } from './analytics/Analytics.js';
import { Settings } from './settings/Settings.js';
import type { SettingsPatch } from './settings/settingsPatch.js';
import { presentError } from './content/errorPresentation.js';
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
    /**
     * Incremented every time the queue is re-read.
     *
     * The songs screen needs to know the queue MOVED, not merely what it now
     * contains: a handoff that replaces one waiting song with another leaves an
     * identical-looking array, and the now-playing card still has to re-read
     * because the bot just put a new track into Spotify.
     */
    const [queueRevision, setQueueRevision] = useState(0);

    const token = auth.accessToken;

    // ---- what is true right now --------------------------------------------

    /**
     * Re-reads the song queue.
     *
     * Declared above the realtime effect because both it and the songs screen use
     * it, and there is only one right way to do it: the `song_queue.updated` event
     * announces that the queue moved and does not carry it, so every path that
     * learns the queue changed — the event, and the screen's own drop — has to
     * fetch. Two copies of that fetch is how one of them ends up reading a
     * different limit than the other.
     */
    const reloadQueue = useCallback((): void => {
        void withFreshSession(sessionStorage, (accessToken) =>
            apiRequest<{ items: QueuedSong[]; total: number }>('/api/v1/songs', { accessToken }))
            .then((songs) => { setQueue(songs.items); setQueueRevision((n) => n + 1); })
            .catch(() => { /* the next status refresh picks it up */ });
    }, [sessionStorage]);

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
            // Bumped here too: this path runs on reconnect, and a socket that has
            // been away is exactly when the songs screen most needs to re-read
            // what is playing rather than trust what it drew before the drop.
            setQueueRevision((n) => n + 1);
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
                    // the queue moved, and the payload does not carry it. The
                    // event now carries `queueLength`, which is deliberately not
                    // used to shortcut this — a length is not a list, and
                    // rendering rows from one would mean inventing them.
                    reloadQueue();
                }
            }
        });

        connectionRef.start();
        return () => { connectionRef.stop(); };
    }, [auth.phase, token, loadDashboard, reloadQueue, sessionStorage]);

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

    // ---- settings, owned here because `/me` is ------------------------------

    /**
     * Saves a settings patch and puts the server's answer back into `/me`.
     *
     * **The shell owns `ChannelSettings` and the panes do not.** Three screens
     * edit the same object — the songs page's requests toggle, the AI pane, the
     * songs pane — and the header pill reads one of its fields. A pane holding its
     * own copy would let two of them disagree about the same setting, with the
     * header agreeing with whichever rendered last.
     *
     * **Not optimistic, unlike the master switch, and the difference is
     * deliberate.** `PATCH /me/settings` does real work on the way through:
     * naming a playlist resolves it at Spotify and may create one, and switching
     * requests off hides a Twitch reward. The response is the only account of what
     * actually happened, so showing a guess first and correcting it after would
     * flicker a name the server may have resolved to something else.
     *
     * An empty patch is a re-read and sends no body — see `SettingsPatch`. The
     * schema refuses an empty object, so this is not merely an optimisation.
     */
    const saveSettings = useCallback(async (patch: SettingsPatch): Promise<string | null> => {
        const current = auth.me;
        if (!current) return 'You are not signed in';

        try {
            if (Object.keys(patch).length === 0) {
                await auth.refreshMe();
                return null;
            }

            const updated = await withFreshSession(sessionStorage, (accessToken) =>
                apiRequest<ChannelSettings>('/api/v1/me/settings', {
                    method: 'PATCH',
                    body: patch,
                    accessToken
                }));

            auth.setMe({ ...current, settings: updated } satisfies MeResponse);
            return null;
        } catch (error) {
            return presentError(error).message;
        }
    }, [auth, sessionStorage]);

    /**
     * The danger zone.
     *
     * `/me` is re-read rather than patched locally: disconnecting moves `status`,
     * stops the session and removes three rewards, and the header, the songs page
     * and the account card all read some part of that. Reconstructing it here would
     * be this component deciding what a teardown did.
     */
    const disconnectChannel = useCallback(async (): Promise<string | null> => {
        try {
            await withFreshSession(sessionStorage, (accessToken) =>
                apiRequest<ChannelDisconnectedResponse>('/api/v1/me/channel', {
                    method: 'DELETE',
                    accessToken
                }));

            await auth.refreshMe();
            return null;
        } catch (error) {
            return presentError(error).message;
        }
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

    /**
     * Spotify's consent chain, in the system browser for the same reason Twitch's
     * is: the app must never see the account password, and an embedded webview
     * asking for one is indistinguishable from a phishing page.
     */
    const connectSpotify = useCallback((): void => {
        void platform.openExternal(`${API_BASE_URL}/auth/spotify/connect`).catch(() => {
            /*
             * Swallowed here, unlike the Twitch grant above, and the asymmetry is
             * deliberate rather than an oversight. The channel connect button is a
             * dead end if the browser will not open — there is no app without it —
             * so it earns a visible error. Spotify is an optional feature reached
             * from a card that keeps explaining itself, so the honest thing is to
             * leave the streamer looking at that card rather than at a message
             * about their browser.
             */
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
                                        : section === 'songs'
                                            ? (
                                                <Songs
                                                    storage={sessionStorage}
                                                    settings={auth.me.settings}
                                                    queue={queue}
                                                    queueRevision={queueRevision}
                                                    onQueueChanged={reloadQueue}
                                                    onSettingsChange={saveSettings}
                                                    onConnectSpotify={connectSpotify}
                                                />
                                            )
                                            : section === 'analytics'
                                                ? <Analytics storage={sessionStorage} />
                                                : (
                                                    <Settings
                                                        storage={sessionStorage}
                                                        channel={auth.me.channel}
                                                        settings={auth.me.settings}
                                                        onSettingsChange={saveSettings}
                                                        onSignOut={() => { void auth.signOut(); }}
                                                        onDisconnectChannel={disconnectChannel}
                                                        onConnectSpotify={connectSpotify}
                                                    />
                                                )}
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
