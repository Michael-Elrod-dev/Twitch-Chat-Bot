import type { Logger } from '../logger.js';
import type { HelixApi } from '../twitch/helixApi.js';
import type { StreamRepository } from '../db/repositories/streamRepository.js';
import type { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import type { StreamService } from './streamService.js';
import { ManualReauthRequiredError } from '../twitch/errors.js';

/**
 * Who is watching, polled from the chatters endpoint.
 *
 * This is the promised caller for `touchPresence` — the method P1-WP4 wrote and
 * deliberately left uncalled until something legitimately knew about presence
 * without knowing about roles.
 *
 * **The P1-1 lesson is the whole design.** Phase 0's poll wrote role columns
 * with defaults, so once a minute it erased every moderator and VIP flag the
 * chat path had learned. The chatters endpoint returns ids and logins and
 * nothing else, so this path writes presence and *never* a role. Role truth
 * stays with the chat events that actually observe it.
 *
 * Lifecycle follows the playback monitor: start/stop idempotent, unref'd timer,
 * owned by the session so it cannot outlive the channel it polls.
 */

/** Phase 0 polled every 60s. Same trade of freshness against Helix calls. */
const DEFAULT_POLL_MS = 60_000;

export interface PresenceTrackerOptions {
    channelId: string;
    broadcasterTwitchId: string;
    streams: StreamService;
    streamRepository: StreamRepository;
    roles: ChannelRoleRepository;
    helix: HelixApi;
    /** The broadcaster's token: they hold `moderator:read:chatters` for their own channel. */
    userToken: () => Promise<string>;
    logger: Logger;
    pollMs?: number;
    setIntervalImpl?: typeof setInterval;
    clearIntervalImpl?: typeof clearInterval;
}

export class PresenceTracker {
    private readonly options: PresenceTrackerOptions;
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private ticking = false;

    constructor(options: PresenceTrackerOptions) {
        this.options = options;
    }

    get isRunning(): boolean {
        return this.running;
    }

    start(): void {
        if (this.running) return;
        this.running = true;

        const setIntervalFn = this.options.setIntervalImpl ?? setInterval;
        this.timer = setIntervalFn(() => {
            void this.tick();
        }, this.options.pollMs ?? DEFAULT_POLL_MS);

        this.timer.unref?.();
        this.options.logger.info({ channelId: this.options.channelId }, 'Presence tracker started');
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;

        if (this.timer) {
            (this.options.clearIntervalImpl ?? clearInterval)(this.timer);
            this.timer = null;
        }

        this.options.logger.info({ channelId: this.options.channelId }, 'Presence tracker stopped');
    }

    /** Exposed so tests drive a tick rather than waiting a minute for one. */
    async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;

        try {
            const streamId = this.options.streams.currentStreamId();

            // Offline: nobody is watching a stream that is not running, and a
            // viewing session with no stream has nothing to belong to.
            if (!streamId) return;

            const token = await this.options.userToken();
            const chatters = await this.options.helix.getChatters(
                this.options.broadcasterTwitchId,
                // The broadcaster is implicitly their own moderator, and it is
                // their token that carries moderator:read:chatters.
                this.options.broadcasterTwitchId,
                token
            );

            const present = new Set(chatters.map((c) => c.twitchUserId));
            const alreadyOpen = new Set(await this.options.streamRepository.openViewers(streamId));
            const at = new Date();

            for (const chatter of chatters) {
                // Presence only. Never roles - see the class comment.
                await this.options.roles.touchPresence(chatter.twitchUserId, chatter.login);

                if (!alreadyOpen.has(chatter.twitchUserId)) {
                    await this.options.streamRepository.openViewingSession(streamId, chatter.twitchUserId, at);
                }
            }

            const departed = [...alreadyOpen].filter((id) => !present.has(id));
            const closed = await this.options.streamRepository.closeViewingSessions(streamId, departed, at);

            await this.options.streamRepository.setPeakViewers(streamId, present.size);

            this.options.logger.debug(
                { channelId: this.options.channelId, present: present.size, closed },
                'Presence polled'
            );
        } catch (err) {
            /*
             * A dead broadcaster authorization is not transient, and polling on
             * would attempt an impossible refresh every minute. Same reasoning
             * as the playback monitor: stop, and say why.
             */
            if (err instanceof ManualReauthRequiredError) {
                this.options.logger.error(
                    { channelId: this.options.channelId },
                    'Broadcaster authorization is no longer valid - stopping the presence tracker'
                );
                this.stop();
                return;
            }

            // Everything else is transient. Presence is a best-effort signal;
            // losing a poll costs a minute of resolution, not correctness.
            this.options.logger.warn(
                { channelId: this.options.channelId, err: (err as Error).message },
                'Presence poll failed'
            );
        } finally {
            this.ticking = false;
        }
    }
}
