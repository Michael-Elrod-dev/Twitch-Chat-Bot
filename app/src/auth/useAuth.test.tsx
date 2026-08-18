import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAuth } from './useAuth.js';
import { memorySessionStorage } from './sessionStore.js';
import type { Platform } from '../platform/tauri.js';

/**
 * The deep-link handler, asserted at the hook.
 *
 * These properties are about `error` and `phase`, and the signed-in shell has
 * nowhere that renders `error`, because the banner surface belongs to the
 * dashboard. Asserting through the rendered app would therefore pass whether or
 * not the code was correct, so the assertions live here where they are real.
 */

const ME = {
    twitchUserId: '1001',
    login: 'streamer',
    channel: { id: 'c1', login: 'streamer', displayName: null, status: 'active', enabled: true },
    settings: null
};

function platformFor(): { platform: Platform; deliver: (url: string) => void; opened: string[] } {
    const opened: string[] = [];
    let handler: ((url: string) => void) | null = null;

    return {
        opened,
        deliver: (url) => { handler?.(url); },
        platform: {
            controls: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
            openExternal: async (url) => { opened.push(url); },
            onDeepLink: async (fn) => { handler = fn; return () => { handler = null; }; },
            canReceiveCallback: async () => true
        }
    };
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/healthz')) return new Response('ok');
        if (url.includes('/api/v1/me')) {
            return new Response(JSON.stringify({ ok: true, data: ME }), {
                status: 200, headers: { 'content-type': 'application/json' }
            });
        }
        throw new Error(`unstubbed: ${url}`);
    }));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('boot', () => {
    it('probes once, even when the caller passes a fresh storage each render', async () => {
        /*
         * Keying the boot effect on the `storage` object would let an
         * unmemoized argument re-run boot on every render, an
         * endless `/healthz` and `/me` loop that also resets `phase` continuously,
         * so the app silently undid whatever the user had just done. App.tsx
         * happens to memoize, so production was correct by luck; a hook should
         * not depend on its caller remembering.
         */
        const { platform } = platformFor();
        const { result, rerender } = renderHook(
            () => useAuth(platform, memorySessionStorage(null))
        );

        await waitFor(() => { expect(result.current.phase).toBe('signed_out'); });
        const afterBoot = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

        rerender();
        rerender();
        rerender();
        await waitFor(() => { expect(result.current.serverReachable).toBe(true); });

        expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
            .toBe(afterBoot);
    });

    it('does not undo a sign-in that started mid-render', async () => {
        // The user-visible half of the same bug: the phase kept snapping back.
        const { platform } = platformFor();
        const { result, rerender } = renderHook(
            () => useAuth(platform, memorySessionStorage(null))
        );

        await waitFor(() => { expect(result.current.phase).toBe('signed_out'); });
        await act(async () => { await result.current.beginSignIn(); });

        rerender();
        await waitFor(() => { expect(result.current.phase).toBe('waiting'); });
    });
});

describe('the deep-link callback', () => {
    const nonceFrom = (url: string): string =>
        new URL(decodeURIComponent(url.split('return_to=')[1] ?? '')).searchParams.get('n') ?? '';

    it('does not accuse a redelivered callback of being an attack', async () => {
        /*
         * The same URL legitimately arrives twice: a cold start replays the URL
         * that launched the app AND the listener fires, and StrictMode mounts
         * the effect twice in development. Treating the second as hostile puts
         * a security warning on the happy path, the worst possible place for
         * one, because it teaches the user to ignore it.
         */
        const { platform, deliver, opened } = platformFor();
        const storage = memorySessionStorage(null);
        const { result } = renderHook(() => useAuth(platform, storage));

        await waitFor(() => { expect(result.current.phase).toBe('signed_out'); });
        await act(async () => { await result.current.beginSignIn(); });

        const callback = `almosthadai://auth?n=${nonceFrom(opened[0] ?? '')}#access_token=at&refresh_token=rt`;
        await act(async () => { deliver(callback); });
        await act(async () => { deliver(callback); });

        await waitFor(() => { expect(result.current.phase).toBe('signed_in'); });
        expect(result.current.error).toBeNull();
        expect(storage.read()).toEqual({ accessToken: 'at', refreshToken: 'rt' });
    });

    it('still refuses a DIFFERENT callback once one has been consumed', async () => {
        // The redelivery tolerance must not become a blanket amnesty: a second,
        // different URL after a completed sign-in is not a redelivery.
        const { platform, deliver, opened } = platformFor();
        const storage = memorySessionStorage(null);
        const { result } = renderHook(() => useAuth(platform, storage));

        await waitFor(() => { expect(result.current.phase).toBe('signed_out'); });
        await act(async () => { await result.current.beginSignIn(); });

        const nonce = nonceFrom(opened[0] ?? '');
        await act(async () => {
            deliver(`almosthadai://auth?n=${nonce}#access_token=at&refresh_token=rt`);
        });
        await waitFor(() => { expect(result.current.phase).toBe('signed_in'); });

        await act(async () => {
            deliver('almosthadai://auth?n=attacker#access_token=evil&refresh_token=evil');
        });

        await waitFor(() => { expect(result.current.error).toMatch(/did not start/); });
        // And the hostile tokens were never stored.
        expect(storage.read()).toEqual({ accessToken: 'at', refreshToken: 'rt' });
    });

    it('says so when the browser will not open, instead of stranding the user', async () => {
        /*
         * The failure this covers: `openUrl` is scope-enforced by the shell, so
         * a capability granting the command without a URL scope rejects every
         * call. The button then appears simply dead, and worse, the app has
         * already moved to "Finish up in your browser", telling the user to go
         * and do something in a window that never opened.
         */
        const { platform } = platformFor();
        const refusing: Platform = {
            ...platform,
            openExternal: async () => { throw new Error('opener.open_url not allowed by scope'); }
        };
        const storage = memorySessionStorage(null);
        const { result } = renderHook(() => useAuth(refusing, storage));

        await waitFor(() => { expect(result.current.phase).toBe('signed_out'); });
        await act(async () => { await result.current.beginSignIn(); });

        expect(result.current.error).toMatch(/Could not open your browser/);
        // Still on the screen with the button, not on the waiting screen.
        expect(result.current.phase).toBe('signed_out');
    });

    it('does not leave a pending attempt behind when the browser fails to open', async () => {
        // Otherwise the next callback to arrive, from anywhere, would match a
        // nonce for an attempt that never actually started.
        // `onDeepLink` is shared with the spread below, so `deliver` still
        // reaches the handler this hook registers.
        const { platform, deliver } = platformFor();
        const refusing: Platform = {
            ...platform,
            openExternal: async () => { throw new Error('nope'); }
        };
        const storage = memorySessionStorage(null);
        const { result } = renderHook(() => useAuth(refusing, storage));

        await waitFor(() => { expect(result.current.phase).toBe('signed_out'); });
        await act(async () => { await result.current.beginSignIn(); });

        await act(async () => {
            deliver('almosthadai://auth?n=anything#access_token=evil&refresh_token=evil');
        });

        expect(storage.read()).toBeNull();
        expect(result.current.phase).toBe('signed_out');
    });

    it('refuses to start a flow when the callback cannot be delivered', async () => {
        const { platform, opened } = platformFor();
        const blocked: Platform = { ...platform, canReceiveCallback: async () => false };
        const { result } = renderHook(() => useAuth(blocked, memorySessionStorage(null)));

        await waitFor(() => { expect(result.current.phase).toBe('signed_out'); });
        await act(async () => { await result.current.beginSignIn(); });

        expect(result.current.error).toMatch(/no handler for almosthadai/);
        // No OAuth state was minted, so nothing was spent on a flow that could
        // not have completed.
        expect(opened).toHaveLength(0);
        expect(result.current.phase).toBe('signed_out');
    });
});
