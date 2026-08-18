import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '@almosthadai/shared';
import { apiRequest, type RequestOptions } from '../api/client.js';
import { withFreshSession, type SessionStorage } from '../auth/sessionStore.js';
import { isAlreadyGone, presentError, type PresentedError } from './errorPresentation.js';

/**
 * One list of things the owner manages, and the two ways it changes.
 *
 * The three content screens differ in what they render and agree completely on
 * how they behave: fetch a page, mutate optimistically, put it back if the
 * server refuses. That agreement lives here rather than three times over,
 * partly to save the typing and mostly because "rollback on error" is the sort of
 * rule that gets implemented three times and remembered twice.
 *
 * **Optimistic, with the rollback as the point.** A list that waits for a round
 * trip before showing a new row reads as broken on a slow connection; a list
 * that never puts the row back when the server refuses is worse, because it
 * silently lies about what was saved. The snapshot is taken before the change
 * and restored on any failure.
 */

export interface Collection<T> {
    items: T[];
    total: number;
    /** True only during the first load; a refresh does not blank the screen. */
    loading: boolean;
    /** Banner-placed problems. Field and inline ones belong to the form. */
    banner: string | null;
    dismissBanner: () => void;
    reload: () => Promise<void>;
    /**
     * Applies `optimistic` at once, runs `request`, and puts the list back
     * exactly as it was if the request fails.
     *
     * @returns null on success, or the presented error for the caller to place.
     */
    mutate: (
        optimistic: (current: T[]) => T[],
        request: (accessToken: string) => Promise<unknown>,
        options?: { totalDelta?: number; treatGoneAsDone?: boolean }
    ) => Promise<PresentedError | null>;
}

export interface CollectionOptions {
    /** Where the list lives, without query string. */
    path: string;
    storage: SessionStorage;
    limit?: number;
    offset?: number;
    /** Skips loading entirely, for while the shell has no channel yet. */
    enabled?: boolean;
}

export function useCollection<T>({
    path,
    storage,
    limit = 50,
    offset = 0,
    enabled = true
}: CollectionOptions): Collection<T> {
    const [items, setItems] = useState<T[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(enabled);
    const [banner, setBanner] = useState<string | null>(null);

    /*
     * Held in a ref for the same reason `useAuth` holds its storage in one: a
     * caller who builds a fresh object each render would otherwise re-run the
     * load on every render, and the hook should not depend on its caller having
     * remembered to memoize.
     */
    const storageRef = useRef(storage);
    storageRef.current = storage;

    /** Guards against a slow first response overwriting a newer one. */
    const requestSeq = useRef(0);

    const reload = useCallback(async (): Promise<void> => {
        if (!enabled) return;

        const seq = ++requestSeq.current;
        try {
            const page = await withFreshSession(storageRef.current, (accessToken) =>
                apiRequest<Page<T>>(`${path}?limit=${limit}&offset=${offset}`, { accessToken }));

            if (seq !== requestSeq.current) return;
            setItems(page.items);
            setTotal(page.total);
            setBanner(null);
        } catch (error) {
            if (seq !== requestSeq.current) return;
            const presented = presentError(error);
            // A failed LOAD is always a banner: there is no field to blame and
            // nothing on screen the message could sit beside.
            setBanner(presented.message);
        } finally {
            if (seq === requestSeq.current) setLoading(false);
        }
    }, [path, storage, limit, offset, enabled]);

    useEffect(() => { void reload(); }, [reload]);

    const mutate = useCallback(async (
        optimistic: (current: T[]) => T[],
        request: (accessToken: string) => Promise<unknown>,
        options: { totalDelta?: number; treatGoneAsDone?: boolean } = {}
    ): Promise<PresentedError | null> => {
        // The snapshot, taken before anything moves.
        let snapshot: T[] = [];
        setItems((current) => { snapshot = current; return optimistic(current); });
        setTotal((current) => current + (options.totalDelta ?? 0));

        try {
            await withFreshSession(storageRef.current, request);
            return null;
        } catch (error) {
            /*
             * Deleting something already deleted has reached the state the user
             * asked for. Rolling the row back so it can be deleted again would
             * be pedantry about a race they cannot see.
             */
            if (options.treatGoneAsDone && isAlreadyGone(error)) return null;

            setItems(snapshot);
            setTotal((current) => current - (options.totalDelta ?? 0));

            const presented = presentError(error);
            if (presented.placement === 'banner') setBanner(presented.message);
            // Field and inline placements are the caller's to render: only the
            // form knows which field the message belongs beside.
            return presented;
        }
    }, [storage]);

    return {
        items,
        total,
        loading,
        banner,
        dismissBanner: useCallback(() => { setBanner(null); }, []),
        reload,
        mutate
    };
}

/** The request helper the screens pass to `mutate`, so the shape is written once. */
export function jsonRequest(
    path: string,
    options: Omit<RequestOptions, 'accessToken'>
): (accessToken: string) => Promise<unknown> {
    return (accessToken) => apiRequest(path, { ...options, accessToken });
}
