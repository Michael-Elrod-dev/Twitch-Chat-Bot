import { useCallback, useEffect, useRef, useState } from 'react';
import type { MeResponse } from '@almosthadai/shared';
import { API_BASE_URL } from '../api/config.js';
import { ApiError, apiRequest, pingServer } from '../api/client.js';
import type { Platform } from '../platform/tauri.js';
import {
    browserSessionStorage,
    signOut as endSession,
    withFreshSession,
    type SessionStorage
} from './sessionStore.js';
import { generateNonce, parseAuthCallback, returnToWithNonce } from './deepLink.js';

/**
 * The whole auth arc: signed out → waiting on the browser → signed in.
 *
 * `phase` is what picks the screen, and the states are deliberately distinct
 * from "do we have a token": a user who is signed in but has connected no
 * channel is in an ordinary state (`/me` answers `channel: null`), and that is
 * what puts them on the onboarding screen rather than on an error.
 */

export type AuthPhase = 'loading' | 'signed_out' | 'waiting' | 'signed_in';

export interface AuthState {
    phase: AuthPhase;
    me: MeResponse | null;
    accessToken: string | null;
    serverReachable: boolean | null;
    error: string | null;
}

export interface UseAuth extends AuthState {
    beginSignIn: () => Promise<void>;
    reopenSignIn: () => Promise<void>;
    cancelSignIn: () => void;
    signOut: () => Promise<void>;
    refreshMe: () => Promise<void>;
    setMe: (me: MeResponse) => void;
}

export function useAuth(platform: Platform, storage: SessionStorage = browserSessionStorage()): UseAuth {
    const [phase, setPhase] = useState<AuthPhase>('loading');
    const [me, setMe] = useState<MeResponse | null>(null);
    const [accessToken, setAccessToken] = useState<string | null>(null);
    const [serverReachable, setServerReachable] = useState<boolean | null>(null);
    const [error, setError] = useState<string | null>(null);

    /**
     * The nonce for the sign-in currently in flight, or null when none is.
     *
     * Doubles as the gate on deep links: any local program can invoke a
     * registered URI scheme, so a callback that arrives when the app did not
     * start one is refused outright rather than turned into a session.
     */
    const pendingNonce = useRef<string | null>(null);

    /**
     * The last callback URL already turned into a session.
     *
     * The same URL can legitimately arrive twice: a cold start replays the URL
     * that launched the app AND the listener fires, and React StrictMode mounts
     * the effect twice in development. Without this, the second delivery finds
     * the nonce already spent and accuses a perfectly good sign-in of being one
     * "this app did not start" — a false alarm on the happy path, which is the
     * worst kind of security warning to show.
     */
    const consumedCallback = useRef<string | null>(null);

    /**
     * Held in a ref so effects cannot be retriggered by its identity.
     *
     * The boot effect probes the server and loads `/me`; keying it on a
     * `storage` object means a caller who passes a fresh one each render
     * re-runs boot on every render — an endless request loop that also keeps
     * resetting `phase`, so the UI appears to ignore what the user just did.
     * The hook should not depend on its caller having remembered to memoize.
     */
    const storageRef = useRef(storage);
    storageRef.current = storage;

    const loadMe = useCallback(async (): Promise<void> => {
        try {
            const response = await withFreshSession(storageRef.current, (token) => {
                setAccessToken(token);
                return apiRequest<MeResponse>('/api/v1/me', { accessToken: token });
            });
            setMe(response);
            setPhase('signed_in');
            setError(null);
        } catch (err) {
            if (err instanceof ApiError && err.code === 'unauthorized') {
                storageRef.current.clear();
                setAccessToken(null);
                setMe(null);
                setPhase('signed_out');
                return;
            }
            /*
             * An unreachable server must NOT sign anybody out. The session is
             * still valid; we simply cannot see it. Dropping to the sign-in
             * screen on a network blip would throw away a working session and
             * make the user re-authorize for nothing.
             */
            setError(err instanceof ApiError ? err.message : 'Something went wrong');
            setPhase(storageRef.current.read() ? 'signed_in' : 'signed_out');
        }
    }, []);

    // Boot: probe reachability and try whatever session is on disk.
    useEffect(() => {
        let cancelled = false;

        void (async () => {
            const reachable = await pingServer();
            if (!cancelled) setServerReachable(reachable);

            if (!storageRef.current.read()) {
                if (!cancelled) setPhase('signed_out');
                return;
            }
            if (!cancelled) await loadMe();
        })();

        return () => { cancelled = true; };
    }, [loadMe]);

    // The callback from the browser.
    useEffect(() => {
        let unsubscribe: (() => void) | null = null;
        let cancelled = false;

        void (async () => {
            const off = await platform.onDeepLink((url) => {
                const callback = parseAuthCallback(url);
                if (!callback) return;

                // Already handled — a redelivery of the same URL, not a second
                // sign-in attempt.
                if (consumedCallback.current === url) return;

                const expected = pendingNonce.current;
                if (!expected || callback.nonce !== expected) {
                    // Either nothing was in flight or the nonce does not match
                    // the attempt we started. Both mean this session was not
                    // asked for, and accepting it would sign the user into
                    // someone else's account.
                    setError('Ignored a sign-in this app did not start.');
                    return;
                }

                consumedCallback.current = url;
                pendingNonce.current = null;
                storageRef.current.write({
                    accessToken: callback.accessToken,
                    refreshToken: callback.refreshToken
                });
                setError(null);
                void loadMe();
            });

            if (cancelled) { off(); return; }
            unsubscribe = off;
        })();

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, [platform, loadMe]);

    /**
     * @returns whether the browser actually opened.
     *
     * The return value matters. Opening the system browser can fail for
     * reasons the app cannot see coming — the shell refusing the URL, no
     * default browser — and a failure here strands the user on a waiting
     * screen watching for a callback that was never asked for. Silence is the
     * worst outcome: nothing to read, nothing to retry, no way to tell the
     * difference between "nothing happened" and "something is broken".
     */
    const openSignInTab = useCallback(async (nonce: string): Promise<boolean> => {
        const returnTo = encodeURIComponent(returnToWithNonce(nonce));
        try {
            await platform.openExternal(`${API_BASE_URL}/auth/app/login?return_to=${returnTo}`);
            return true;
        } catch (err) {
            setError(
                `Could not open your browser to sign in (${err instanceof Error ? err.message : String(err)}). `
                + 'Nothing was sent to Twitch.'
            );
            return false;
        }
    }, [platform]);

    const beginSignIn = useCallback(async (): Promise<void> => {
        /*
         * Refuse before Twitch is involved.
         *
         * Every `/auth/app/login` mints a single-use OAuth state. If the
         * callback cannot be delivered back to this machine, consent still
         * succeeds and the state is still spent — so the user waits forever,
         * retries, and the browser starts telling them the authorization link
         * is no longer valid. That message is true and completely unhelpful:
         * the link was fine, there was nothing here to hand it to. Checking
         * first turns an undiagnosable loop into one sentence.
         */
        if (!(await platform.canReceiveCallback())) {
            setError(
                'This machine has no handler for almosthadai:// links, so Twitch could not '
                + 'send the sign-in back. Install the app and launch it once, or run it with '
                + '`npm run tauri dev` — signing in from a browser tab cannot complete.'
            );
            setPhase('signed_out');
            return;
        }

        const nonce = generateNonce();
        pendingNonce.current = nonce;
        setError(null);

        // Only move to the waiting screen once the browser is genuinely open.
        // Showing "Finish up in your browser" when no browser opened tells the
        // user to go and do something that is not there to be done.
        if (!await openSignInTab(nonce)) {
            pendingNonce.current = null;
            setPhase('signed_out');
            return;
        }

        setPhase('waiting');
    }, [openSignInTab, platform]);

    const reopenSignIn = useCallback(async (): Promise<void> => {
        // The same attempt, not a new one: re-minting the nonce would orphan a
        // callback the user may already have completed in the first tab.
        const nonce = pendingNonce.current;
        if (!nonce) { await beginSignIn(); return; }
        await openSignInTab(nonce);
    }, [beginSignIn, openSignInTab]);

    const cancelSignIn = useCallback((): void => {
        pendingNonce.current = null;
        setError(null);
        setPhase('signed_out');
    }, []);

    const signOut = useCallback(async (): Promise<void> => {
        await endSession(storageRef.current);
        pendingNonce.current = null;
        setAccessToken(null);
        setMe(null);
        setPhase('signed_out');
    }, []);

    return {
        phase,
        me,
        accessToken,
        serverReachable,
        error,
        beginSignIn,
        reopenSignIn,
        cancelSignIn,
        signOut,
        refreshMe: loadMe,
        setMe
    };
}
