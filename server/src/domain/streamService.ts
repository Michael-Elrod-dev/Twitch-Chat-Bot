import type { Logger } from '../logger.js';
import type { StreamRepository, StreamRecord } from '../db/repositories/streamRepository.js';
import type { HelixApi } from '../twitch/helixApi.js';
import type { StreamContext } from '../ai/promptBuilder.js';

/**
 * What "the stream" means for one channel.
 *
 * Three consumers depend on this being right, and each fails differently when
 * it is not:
 *
 *  - **AI context.** Phase 0 put the title and category in every prompt. Without
 *    it the bot answers "what game is this" with nothing useful.
 *  - **The AI rate-limit bucket.** Limits are per viewer *per stream*. With no
 *    stream id everything shares the offline bucket, so a viewer's allowance
 *    never resets between streams.
 *  - **`!uptime`.** Needs the real start time, not the process start time.
 *
 * The state is deliberately resolved from the DATABASE on start rather than
 * held only in memory. A restart mid-stream must not lose the stream — that was
 * the Phase-0 behaviour (`currentStreamId` was an instance field seeded from
 * `Date.now()`), and it meant every deploy silently began a new "stream".
 */

export interface StreamServiceOptions {
    channelId: string;
    broadcasterTwitchId: string;
    streams: StreamRepository;
    logger: Logger;
    /** Absent means titles and categories stay null; the stream still records. */
    helix?: HelixApi;
    /** Injectable so tests do not depend on wall-clock time. */
    now?: () => number;
}

export class StreamService {
    private readonly options: StreamServiceOptions;
    private current: StreamRecord | null = null;

    constructor(options: StreamServiceOptions) {
        this.options = options;
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    /** Recovers the open stream after a restart. Called when the session starts. */
    async load(): Promise<void> {
        this.current = await this.options.streams.findOpen();

        if (this.current) {
            this.options.logger.info(
                { channelId: this.options.channelId, streamId: this.current.id },
                'Resumed the stream that was open before restart'
            );
        }
    }

    /** @returns the current stream's uuid, or null offline. The rate-limit bucket. */
    currentStreamId(): string | null {
        return this.current?.id ?? null;
    }

    get isLive(): boolean {
        return this.current !== null;
    }

    /** @returns the AI's stream context, or null offline. */
    context(): StreamContext | null {
        if (!this.current) return null;

        return {
            category: this.current.category ?? 'unknown',
            title: this.current.title ?? 'untitled',
            duration: this.uptime() ?? '0m'
        };
    }

    /** @returns a human duration since the stream started, or null offline. */
    uptime(): string | null {
        if (!this.current) return null;

        const elapsedMs = Math.max(0, this.now() - this.current.startedAt.getTime());
        const totalMinutes = Math.floor(elapsedMs / 60_000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }

    async onOnline(twitchStreamId: string, startedAt: Date): Promise<void> {
        /*
         * Metadata is best-effort. A failed Helix call must not cost us the
         * stream row: an untitled stream still buckets rate limits correctly
         * and still answers !uptime, whereas no row at all breaks all three
         * consumers.
         */
        let title: string | null = null;
        let category: string | null = null;

        try {
            const live = await this.options.helix?.getStream(this.options.broadcasterTwitchId);
            if (live) {
                title = live.title;
                category = live.gameName;
            }
        } catch (err) {
            this.options.logger.warn(
                { channelId: this.options.channelId, err: (err as Error).message },
                'Could not fetch stream metadata - recording the stream without it'
            );
        }

        this.current = await this.options.streams.open({
            twitchStreamId,
            startedAt,
            title,
            category
        });

        this.options.logger.info(
            {
                channelId: this.options.channelId,
                streamId: this.current.id,
                twitchStreamId,
                title,
                category
            },
            'Stream started'
        );
    }

    async onOffline(): Promise<void> {
        // Offline without a known stream happens after a restart that missed
        // the online event; findOpen recovers it rather than dropping the close.
        const open = this.current ?? await this.options.streams.findOpen();

        if (!open) {
            this.options.logger.debug(
                { channelId: this.options.channelId },
                'Stream offline with no open stream recorded'
            );
            return;
        }

        await this.options.streams.close(open.id, new Date(this.now()));
        this.current = null;

        this.options.logger.info(
            { channelId: this.options.channelId, streamId: open.id },
            'Stream ended'
        );
    }
}
