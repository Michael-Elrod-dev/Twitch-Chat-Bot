import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pino } from 'pino';
import { RevocationRecovery } from './revocationRecovery.js';
import type { EventSubSubscriptionInfo } from './messages.js';
import type { SubscriptionReconciler } from './subscriptionReconciler.js';
import type { ChannelRepository, ChannelStatus } from '../../db/repositories/channelRepository.js';

const logger = pino({ level: 'silent' });

const revocation = (overrides: Partial<EventSubSubscriptionInfo> = {}): EventSubSubscriptionInfo => ({
    id: 'sub-1',
    type: 'channel.chat.message',
    version: '1',
    status: 'notification_failures_exceeded',
    condition: { broadcaster_user_id: '1001', user_id: 'bot' },
    ...overrides
});

describe('RevocationRecovery', () => {
    let statuses: { channelId: string; status: ChannelStatus }[];
    let channels: ChannelRepository;
    let reconcile: ReturnType<typeof vi.fn>;
    let reconciler: SubscriptionReconciler;
    let scheduled: (() => void)[];

    const build = (): RevocationRecovery =>
        new RevocationRecovery({
            logger,
            channels,
            reconciler,
            activeBroadcasterIds: () => ['1001'],
            schedule: (fn) => { scheduled.push(fn); }
        });

    /** Runs whatever was scheduled and waits for the async work it kicks off. */
    const runScheduled = async (): Promise<void> => {
        const pending = [...scheduled];
        scheduled = [];
        for (const fn of pending) fn();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
    };

    beforeEach(() => {
        statuses = [];
        scheduled = [];
        reconcile = vi.fn(async () => ({
            create: [], remove: [], keep: [], created: 1, removed: 0, failures: 0, dryRun: false
        }));
        reconciler = { reconcile } as unknown as SubscriptionReconciler;
        channels = {
            findByBroadcasterId: async (id: string) =>
                (id === '1001' ? { id: 'c1', twitchBroadcasterId: '1001', twitchLogin: 'alpha', status: 'active' } : null),
            setStatus: async (channelId: string, status: ChannelStatus) => {
                statuses.push({ channelId, status });
                return true;
            }
        } as unknown as ChannelRepository;
    });

    describe('a recoverable revocation', () => {
        it('schedules one retry rather than retrying immediately', async () => {
            // notification_failures_exceeded usually follows our own outage, so
            // an instant retry would fail for the same reason.
            build().handle(revocation());

            expect(reconcile).not.toHaveBeenCalled();
            expect(scheduled).toHaveLength(1);
        });

        it('resubscribes when the retry runs', async () => {
            build().handle(revocation());
            await runScheduled();

            expect(reconcile).toHaveBeenCalledWith(['1001'], false);
            expect(statuses).toHaveLength(0);
        });

        it('marks the channel needing re-auth when the retry fails', async () => {
            reconcile.mockResolvedValue({
                create: [], remove: [], keep: [], created: 0, removed: 0, failures: 1, dryRun: false
            });

            build().handle(revocation());
            await runScheduled();

            expect(statuses).toEqual([{ channelId: 'c1', status: 'needs_reauth' }]);
        });

        it('marks the channel when the retry throws', async () => {
            reconcile.mockRejectedValue(new Error('helix down'));

            build().handle(revocation());
            await runScheduled();

            expect(statuses).toEqual([{ channelId: 'c1', status: 'needs_reauth' }]);
        });

        it('does not stack retries for the same subscription', async () => {
            // Twitch can deliver a revocation more than once.
            const recovery = build();
            recovery.handle(revocation());
            recovery.handle(revocation());

            expect(scheduled).toHaveLength(1);
        });

        it('retries different subscription types independently', async () => {
            // Per-subscription, not per-channel: this is the whole point.
            const recovery = build();
            recovery.handle(revocation({ type: 'channel.chat.message' }));
            recovery.handle(revocation({ type: 'stream.online' }));

            expect(scheduled).toHaveLength(2);
        });

        it('allows a fresh retry after the previous one completed', async () => {
            const recovery = build();
            recovery.handle(revocation());
            await runScheduled();

            recovery.handle(revocation());
            expect(scheduled).toHaveLength(1);
        });
    });

    describe('a terminal revocation', () => {
        it('goes straight to needs-reauth without retrying', async () => {
            // Retrying an authorization the user withdrew fails identically
            // every time, and the noise would hide the recoverable case.
            build().handle(revocation({ status: 'authorization_revoked' }));

            expect(scheduled).toHaveLength(0);
            await new Promise((resolve) => setImmediate(resolve));
            expect(statuses).toEqual([{ channelId: 'c1', status: 'needs_reauth' }]);
        });

        it('treats user_removed and version_removed the same way', async () => {
            for (const status of ['user_removed', 'version_removed']) {
                statuses = [];
                build().handle(revocation({ status }));
                await new Promise((resolve) => setImmediate(resolve));

                expect(statuses).toHaveLength(1);
            }
        });
    });

    describe('robustness', () => {
        it('returns immediately, so the webhook is never delayed', () => {
            // The endpoint has already answered Twitch by this point.
            const start = Date.now();
            build().handle(revocation({ status: 'authorization_revoked' }));

            expect(Date.now() - start).toBeLessThan(50);
        });

        it('ignores a revocation naming a broadcaster we do not have', async () => {
            build().handle(revocation({ condition: { broadcaster_user_id: '9999' }, status: 'authorization_revoked' }));
            await new Promise((resolve) => setImmediate(resolve));

            expect(statuses).toHaveLength(0);
        });

        it('survives a revocation with no broadcaster in the condition', async () => {
            expect(() => build().handle(revocation({ condition: {}, status: 'authorization_revoked' }))).not.toThrow();
        });

        it('survives the database being unavailable', async () => {
            channels = {
                findByBroadcasterId: async () => { throw new Error('db down'); },
                setStatus: async () => true
            } as unknown as ChannelRepository;

            build().handle(revocation({ status: 'authorization_revoked' }));
            await new Promise((resolve) => setImmediate(resolve));

            // No unhandled rejection, and the process is still standing.
            expect(true).toBe(true);
        });
    });
});
