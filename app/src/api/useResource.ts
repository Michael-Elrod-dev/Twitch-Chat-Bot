import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from './client.js';
import { withFreshSession, type SessionStorage } from '../auth/sessionStore.js';
import { presentError } from '../content/errorPresentation.js';

/**
 * One thing the server knows, fetched and re-fetchable.
 *
 * `useCollection` is the same idea for a list you mutate optimistically. This is
 * its sibling for the reads that are not lists: the Spotify card's status, the
 * now-playing track, the analytics summary. They have no rows to roll back, so
 * they carry none of that machinery — but they share the parts that matter and
 * are easy to get subtly wrong: a sequence guard so a slow first response cannot
 * overwrite a newer one, a `loading` flag that is true only on the FIRST load so
 * a refresh does not blank a working screen, and the same banner placement every
 * other failed load in this app uses.
 *
 * **`null` data is a state, not an error.** `GET /songs/playing` answers `null`
 * when nothing is playing and the songs screen renders an ordinary empty card
 * for it. A hook that treated an absent value as a failure would put a banner
 * over a perfectly healthy bot, which is the one thing the handoff's error rule
 * forbids.
 */

export interface Resource<T> {
    data: T | null;
    /** True only during the first load. */
    loading: boolean;
    /** Banner-placed problems; a failed load has no field to sit beside. */
    banner: string | null;
    dismissBanner: () => void;
    reload: () => Promise<void>;
    /** Replaces the held value without a round trip, for optimistic edits. */
    set: (next: T | null) => void;
}

export interface ResourceOptions {
    path: string;
    storage: SessionStorage;
    /** Skips loading entirely — used while a prerequisite is missing. */
    enabled?: boolean;
}

export function useResource<T>({ path, storage, enabled = true }: ResourceOptions): Resource<T> {
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(enabled);
    const [banner, setBanner] = useState<string | null>(null);

    // Held in a ref for the reason `useCollection` holds its storage in one: a
    // caller that builds a fresh object each render must not re-run the load
    // every render, and the hook should not depend on being memoized correctly.
    const storageRef = useRef(storage);
    storageRef.current = storage;

    const requestSeq = useRef(0);

    const reload = useCallback(async (): Promise<void> => {
        if (!enabled) { setLoading(false); return; }

        const seq = ++requestSeq.current;
        try {
            const next = await withFreshSession(storageRef.current, (accessToken) =>
                apiRequest<T>(path, { accessToken }));

            if (seq !== requestSeq.current) return;
            setData(next ?? null);
            setBanner(null);
        } catch (error) {
            if (seq !== requestSeq.current) return;
            setBanner(presentError(error).message);
        } finally {
            if (seq === requestSeq.current) setLoading(false);
        }
    }, [path, enabled]);

    useEffect(() => { void reload(); }, [reload]);

    return {
        data,
        loading,
        banner,
        dismissBanner: useCallback(() => { setBanner(null); }, []),
        reload,
        set: setData
    };
}
