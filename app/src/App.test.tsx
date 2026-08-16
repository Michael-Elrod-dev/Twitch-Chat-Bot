import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@almosthadai/shared';
import { App } from './App.js';
import { memorySessionStorage, type SessionStorage } from './auth/sessionStore.js';
import type { Platform } from './platform/tauri.js';

/**
 * The auth arc, end to end through the real components.
 *
 * The seams stubbed are the two the app genuinely does not own: the desktop
 * shell (window, browser, deep link) and the network. Everything between the
 * click and the rendered shell is the production path, which is what makes
 * this worth more than the sum of the component tests.
 */

const ME: MeResponse = {
    twitchUserId: '1001',
    login: 'streamer',
    channel: { id: 'c1', login: 'streamer', displayName: null, status: 'active', enabled: true },
    settings: { aiEnabled: true, songRequestsEnabled: true, discordWebhookConfigured: false }
};

const ME_NO_CHANNEL: MeResponse = {
    twitchUserId: '1001', login: 'streamer', channel: null, settings: null
};

interface Harness {
    platform: Platform;
    storage: SessionStorage;
    openedUrls: string[];
    /** Delivers a deep link the way the OS would. */
    deliver: (url: string) => void;
}

function harness(
    storage: SessionStorage = memorySessionStorage(null),
    // The default is a machine that CAN receive the callback. The false case is
    // its own test: it is the one that produced an undiagnosable sign-in loop.
    canReceiveCallback = true
): Harness {
    const openedUrls: string[] = [];
    let handler: ((url: string) => void) | null = null;

    return {
        storage,
        openedUrls,
        deliver: (url) => { handler?.(url); },
        platform: {
            controls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
            openExternal: async (url) => { openedUrls.push(url); },
            onDeepLink: async (fn) => { handler = fn; return () => { handler = null; }; },
            canReceiveCallback: async () => canReceiveCallback
        }
    };
}

/** Routes by path so a test states only the responses it cares about. */
function stubFetch(routes: Record<string, () => Response>): void {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        for (const [fragment, make] of Object.entries(routes)) {
            if (url.includes(fragment)) return make();
        }
        throw new Error(`unstubbed request: ${url}`);
    }));
}

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ok = (data: unknown): Response => json({ ok: true, data });

/**
 * jsdom has no WebSocket, and the shell opens one the moment it is signed in.
 *
 * `connects` is the interesting switch: a socket that never opens is exactly
 * the `4b` case, and one that opens is the only state in which the header's
 * controls are live at all.
 */
function stubWebSocket({ connects }: { connects: boolean }): void {
    vi.stubGlobal('WebSocket', class {
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onmessage: (() => void) | null = null;

        constructor() {
            if (!connects) return;
            queueMicrotask(() => { this.onopen?.(); });
        }

        close(): void { /* nothing to close */ }
    });
}

beforeEach(() => {
    stubWebSocket({ connects: false });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the auth arc', () => {
    it('starts on sign-in with no stored session', async () => {
        stubFetch({ '/healthz': () => new Response('ok') });
        const h = harness();

        render(<App platform={h.platform} storage={h.storage} />);

        expect(await screen.findByRole('button', { name: /Continue with Twitch/ })).toBeInTheDocument();
        expect(await screen.findByText('SERVER REACHABLE')).toBeInTheDocument();
    });

    it('reports an unreachable server on the sign-in screen', async () => {
        stubFetch({ '/healthz': () => { throw new Error('offline'); } });
        const h = harness();

        render(<App platform={h.platform} storage={h.storage} />);
        expect(await screen.findByText('SERVER UNREACHABLE')).toBeInTheDocument();
    });

    it('opens the SYSTEM browser and moves to the waiting screen', async () => {
        stubFetch({ '/healthz': () => new Response('ok') });
        const h = harness();
        render(<App platform={h.platform} storage={h.storage} />);

        await userEvent.click(await screen.findByRole('button', { name: /Continue with Twitch/ }));

        expect(await screen.findByRole('status')).toHaveTextContent('Waiting for Twitch');
        expect(h.openedUrls[0]).toContain('/auth/app/login?return_to=');
        // The private-use scheme the server allow-lists, and nothing else.
        expect(h.openedUrls[0]).toContain(encodeURIComponent('almosthadai://auth?n='));
    });

    it('completes sign-in when the deep link comes back', async () => {
        stubFetch({
            '/healthz': () => new Response('ok'),
            '/api/v1/me': () => ok(ME)
        });
        const h = harness();
        render(<App platform={h.platform} storage={h.storage} />);

        await userEvent.click(await screen.findByRole('button', { name: /Continue with Twitch/ }));

        const nonce = new URL(decodeURIComponent(h.openedUrls[0]?.split('return_to=')[1] ?? ''))
            .searchParams.get('n');
        h.deliver(`almosthadai://auth?n=${nonce}#access_token=at&refresh_token=rt`);

        // The signed-in shell: rail, channel header, status pill.
        expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
        expect(screen.getByText('streamer')).toBeInTheDocument();
        expect(h.storage.read()).toEqual({ accessToken: 'at', refreshToken: 'rt' });
    });

    it('refuses to start a flow this machine cannot finish', async () => {
        /*
         * The failure this prevents, in full: with no handler registered for
         * `almosthadai://`, Twitch consent succeeds, the server spends the
         * single-use OAuth state redirecting to a URL Windows cannot open, and
         * the user waits forever. Retrying replays the spent state, so the
         * browser answers "this authorization link is no longer valid" — true,
         * and no help at all in working out that the link was never the
         * problem.
         */
        stubFetch({ '/healthz': () => new Response('ok') });
        const h = harness(memorySessionStorage(null), false);
        render(<App platform={h.platform} storage={h.storage} />);

        await userEvent.click(await screen.findByRole('button', { name: /Continue with Twitch/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/no handler for almosthadai/);
        // Crucially: no OAuth state was minted, and the user is still where
        // they can act rather than stranded on a waiting screen.
        expect(h.openedUrls).toHaveLength(0);
        expect(screen.getByRole('button', { name: /Continue with Twitch/ })).toBeInTheDocument();
    });

    it('refuses a deep link the app did not start', async () => {
        stubFetch({ '/healthz': () => new Response('ok') });
        const h = harness();
        render(<App platform={h.platform} storage={h.storage} />);

        await screen.findByRole('button', { name: /Continue with Twitch/ });

        // A hostile local process invoking the scheme with its own session.
        h.deliver('almosthadai://auth?n=attacker#access_token=evil&refresh_token=evil');

        expect(await screen.findByRole('alert')).toHaveTextContent('did not start');
        expect(h.storage.read()).toBeNull();
    });

    it('refuses a callback whose nonce does not match the attempt in flight', async () => {
        stubFetch({ '/healthz': () => new Response('ok') });
        const h = harness();
        render(<App platform={h.platform} storage={h.storage} />);

        await userEvent.click(await screen.findByRole('button', { name: /Continue with Twitch/ }));
        h.deliver('almosthadai://auth?n=not-the-one#access_token=evil&refresh_token=evil');

        expect(await screen.findByRole('alert')).toHaveTextContent('did not start');
        expect(h.storage.read()).toBeNull();
    });

    it('can be cancelled back to sign-in', async () => {
        stubFetch({ '/healthz': () => new Response('ok') });
        const h = harness();
        render(<App platform={h.platform} storage={h.storage} />);

        await userEvent.click(await screen.findByRole('button', { name: /Continue with Twitch/ }));
        await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

        expect(await screen.findByRole('button', { name: /Continue with Twitch/ })).toBeInTheDocument();
    });

    it('reopens the same attempt rather than starting a new one', async () => {
        stubFetch({ '/healthz': () => new Response('ok') });
        const h = harness();
        render(<App platform={h.platform} storage={h.storage} />);

        await userEvent.click(await screen.findByRole('button', { name: /Continue with Twitch/ }));
        await userEvent.click(await screen.findByRole('button', { name: 'Open the tab again' }));

        // Same nonce: a fresh one would orphan a callback the user may already
        // have completed in the first tab.
        expect(h.openedUrls).toHaveLength(2);
        expect(h.openedUrls[0]).toBe(h.openedUrls[1]);
    });

    it('shows onboarding for a signed-in user with no channel', async () => {
        stubFetch({
            '/healthz': () => new Response('ok'),
            '/api/v1/me': () => ok(ME_NO_CHANNEL)
        });
        const h = harness(memorySessionStorage({ accessToken: 'at', refreshToken: 'rt' }));

        render(<App platform={h.platform} storage={h.storage} />);

        expect(await screen.findByText('One more handshake and the bot is yours')).toBeInTheDocument();
    });

    it('does not sign anybody out because the server is unreachable', async () => {
        stubFetch({
            '/healthz': () => { throw new Error('offline'); },
            '/api/v1/me': () => { throw new Error('offline'); }
        });
        const stored = { accessToken: 'at', refreshToken: 'rt' };
        const h = harness(memorySessionStorage(stored));

        render(<App platform={h.platform} storage={h.storage} />);

        // A blip must not throw away a working session.
        await waitFor(() => { expect(h.storage.read()).toEqual(stored); });
        expect(screen.queryByRole('button', { name: /Continue with Twitch/ })).not.toBeInTheDocument();
    });

    it('signs out when the session is genuinely rejected', async () => {
        stubFetch({
            '/healthz': () => new Response('ok'),
            '/api/v1/me': () => json({ ok: false, error: { code: 'unauthorized', message: 'no' } }, 401),
            '/auth/app/refresh': () => json({ ok: false, error: { code: 'unauthorized', message: 'no' } }, 401)
        });
        const h = harness(memorySessionStorage({ accessToken: 'at', refreshToken: 'rt' }));

        render(<App platform={h.platform} storage={h.storage} />);

        expect(await screen.findByRole('button', { name: /Continue with Twitch/ })).toBeInTheDocument();
        expect(h.storage.read()).toBeNull();
    });
});

describe('the master switch, against the API', () => {
    const signedIn = async (): Promise<Harness> => {
        const h = harness(memorySessionStorage({ accessToken: 'at', refreshToken: 'rt' }));
        render(<App platform={h.platform} storage={h.storage} />);
        await screen.findByRole('navigation', { name: 'Sections' });
        return h;
    };

    /** The switch is only operable on an open link, so these tests need one. */
    const signedInAndConnected = async (): Promise<Harness> => {
        stubWebSocket({ connects: true });
        const h = await signedIn();
        await waitFor(() => { expect(screen.getByRole('switch')).toBeEnabled(); });
        return h;
    };

    it('sends the flip and takes both fields from the response', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes('/healthz')) return new Response('ok');
            if (url.includes('/api/v1/me/channel')) {
                calls.push(String(init?.body));
                return ok({ enabled: false, status: 'active' });
            }
            if (url.includes('/api/v1/me')) return ok(ME);
            throw new Error(`unstubbed: ${url}`);
        }));

        await signedInAndConnected();
        await userEvent.click(screen.getByRole('switch'));

        await waitFor(() => { expect(screen.getByRole('switch')).not.toBeChecked(); });
        expect(calls).toEqual(['{"enabled":false}']);
    });

    it('rolls the toggle back when the server refuses', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/healthz')) return new Response('ok');
            if (url.includes('/api/v1/me/channel')) {
                return json({ ok: false, error: { code: 'internal', message: 'nope' } }, 500);
            }
            if (url.includes('/api/v1/me')) return ok(ME);
            throw new Error(`unstubbed: ${url}`);
        }));

        await signedInAndConnected();
        expect(screen.getByRole('switch')).toBeChecked();

        await userEvent.click(screen.getByRole('switch'));

        // Optimistic, then back where it started — never silently wrong.
        await waitFor(() => { expect(screen.getByRole('switch')).toBeChecked(); });
    });

    it('shows UNKNOWN while the realtime link is not open', async () => {
        stubFetch({ '/healthz': () => new Response('ok'), '/api/v1/me': () => ok(ME) });
        await signedIn();

        // The stubbed WebSocket never opens, which is exactly the 4b case.
        expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
        expect(screen.queryByText('OFFLINE')).not.toBeInTheDocument();
        expect(screen.getByRole('switch')).toBeDisabled();
    });
});
