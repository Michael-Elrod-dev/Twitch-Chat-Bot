import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { pino } from 'pino';
import type { RedemptionEvent } from '@almosthadai/shared';
import type { DbHandle } from '../db/client.js';
import { connectTestDatabase } from '../db/testing.js';
import { ChannelRepository } from '../db/repositories/channelRepository.js';
import { ChannelRewardRepository } from '../db/repositories/channelRewardRepository.js';
import { QuoteRepository } from '../db/repositories/quoteRepository.js';
import { AnalyticsRepository } from '../db/repositories/analyticsRepository.js';
import { DashboardRepository } from '../db/repositories/dashboardRepository.js';
import { ChatHistoryRepository } from '../db/repositories/chatHistoryRepository.js';
import { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import { StreamRepository } from '../db/repositories/streamRepository.js';
import { DatabaseAnalyticsSink } from '../services/analytics.js';
import { RedemptionPipeline } from './redemptionPipeline.js';
import { RedemptionSettlement } from '../services/redemptionSettlement.js';
import { createQuoteRedemptionHandler, parseQuote } from '../domain/quoteRedemption.js';
import { RateLimitedError, ManualReauthRequiredError } from '../twitch/errors.js';
import type { HelixApi } from '../twitch/helixApi.js';
import type { UserTokenProvider } from '../twitch/userTokenProvider.js';

/**
 * Redemptions spend real channel points, so the invariant under test is blunt:
 * **every redemption ends fulfilled or refunded, never neither.**
 *
 * A redemption left in Twitch's default UNFULFILLED state has taken the
 * viewer's points and given nothing back, and nobody notices until they
 * complain.
 */

const logger = pino({ level: 'silent' });

const redemption = (overrides: Partial<RedemptionEvent> = {}): RedemptionEvent => ({
    kind: 'redemption',
    messageId: `msg-${Math.random()}`,
    broadcasterTwitchId: '1001',
    redemptionId: 'redemption-1',
    rewardId: 'reward-song',
    rewardTitle: 'Song Request',
    userInput: '',
    redeemer: { twitchUserId: 'viewer-1', login: 'viewer', displayName: 'Viewer' },
    ...overrides
});

// ---- the format parser, which decides whether points are kept -------------

describe('parseQuote', () => {
    it('accepts the documented format', () => {
        expect(parseQuote('"Something wise" - Someone')).toEqual({
            text: 'Something wise', author: 'Someone'
        });
    });

    it('accepts curly quotes and long dashes from a phone keyboard', () => {
        // A viewer typing on their phone should not lose points to autocorrect.
        expect(parseQuote('“Something wise” — Someone')).toEqual({
            text: 'Something wise', author: 'Someone'
        });
        expect(parseQuote('\'Quoted\' – Person')).toEqual({ text: 'Quoted', author: 'Person' });
    });

    it('rejects input with no author', () => {
        expect(parseQuote('"Just a quote"')).toBeNull();
    });

    it('rejects unquoted input', () => {
        expect(parseQuote('Something wise - Someone')).toBeNull();
    });

    it('rejects an empty quote or author', () => {
        expect(parseQuote('"   " - Someone')).toBeNull();
        expect(parseQuote('"Something" -    ')).toBeNull();
    });

    it('keeps internal punctuation intact', () => {
        expect(parseQuote('"Wait - what?" - Someone Else')).toEqual({
            text: 'Wait - what?', author: 'Someone Else'
        });
    });
});

// ---- settlement, including the refund retry -------------------------------

describe('RedemptionSettlement', () => {
    type SleepFn = (ms: number) => Promise<void>;

    const buildSettlement = (
        update: ReturnType<typeof vi.fn>,
        sleep: ReturnType<typeof vi.fn<SleepFn>> = vi.fn<SleepFn>(async () => undefined)
    ): RedemptionSettlement =>
        new RedemptionSettlement({
            channelId: 'c1',
            broadcasterTwitchId: '1001',
            helix: { updateRedemptionStatus: update } as unknown as HelixApi,
            userTokens: { get: async () => 'broadcaster-token' } as unknown as UserTokenProvider,
            logger,
            sleep
        });

    it('uses the BROADCASTER user token, not the app token', async () => {
        // Update Redemption Status accepts only a user token with
        // channel:manage:redemptions - the reason channel_tokens exists.
        const update = vi.fn(async () => undefined);
        await buildSettlement(update).settle(redemption(), 'FULFILLED');

        expect(update).toHaveBeenCalledWith('1001', 'broadcaster-token', 'reward-song', 'redemption-1', 'FULFILLED');
    });

    describe('the refund retry (the P1-WP7 flag)', () => {
        it('retries a rate-limited refund once rather than dropping it', async () => {
            // An unrefunded failed redemption is stolen channel points, and
            // "we were rate limited" is not something a viewer can act on.
            const update = vi.fn()
                .mockRejectedValueOnce(new RateLimitedError('/redemptions', 3_000))
                .mockResolvedValueOnce(undefined);
            const sleep = vi.fn<SleepFn>(async () => undefined);

            await buildSettlement(update, sleep).settle(redemption(), 'CANCELED');

            expect(update).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledWith(3_000);
        });

        it('waits the reset hint, capped so it cannot hang', async () => {
            const update = vi.fn()
                .mockRejectedValueOnce(new RateLimitedError('/redemptions', 10 * 60_000))
                .mockResolvedValueOnce(undefined);
            const sleep = vi.fn<SleepFn>(async () => undefined);

            await buildSettlement(update, sleep).settle(redemption(), 'CANCELED');

            expect(sleep.mock.calls[0]?.[0]).toBeLessThanOrEqual(30_000);
        });

        it('retries exactly once, then reports so a human can refund by hand', async () => {
            const update = vi.fn().mockRejectedValue(new RateLimitedError('/redemptions', 1_000));

            await expect(buildSettlement(update).settle(redemption(), 'CANCELED'))
                .rejects.toThrow(RateLimitedError);

            expect(update).toHaveBeenCalledTimes(2);
        });

        it('does NOT retry a rate-limited fulfilment', async () => {
            // The viewer already got what they paid for; the status is cosmetic
            // by comparison, and retrying spends budget the refund path needs.
            const update = vi.fn().mockRejectedValue(new RateLimitedError('/redemptions', 1_000));

            await expect(buildSettlement(update).settle(redemption(), 'FULFILLED'))
                .rejects.toThrow(RateLimitedError);

            expect(update).toHaveBeenCalledTimes(1);
        });

        it('does not retry a non-rate-limit failure', async () => {
            const update = vi.fn().mockRejectedValue(new Error('bad request'));

            await expect(buildSettlement(update).settle(redemption(), 'CANCELED')).rejects.toThrow();
            expect(update).toHaveBeenCalledTimes(1);
        });
    });

    it('surfaces a dead broadcaster token as needing reconnection', async () => {
        const update = vi.fn().mockRejectedValue(new ManualReauthRequiredError('broadcaster token', 'c1'));

        await expect(buildSettlement(update).settle(redemption(), 'CANCELED'))
            .rejects.toThrow(ManualReauthRequiredError);
    });
});

// ---- the pipeline, against a real database --------------------------------

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('RedemptionPipeline', () => {
    let handle: DbHandle;
    let alphaId: string;
    let betaId: string;
    let settled: { status: string; redemptionId: string }[];
    let sent: string[];

    const settlementStub = (): RedemptionSettlement =>
        ({
            settle: async (event: RedemptionEvent, status: string) => {
                settled.push({ status, redemptionId: event.redemptionId });
            }
        }) as unknown as RedemptionSettlement;

    beforeAll(async () => {
        handle = await connectTestDatabase(TEST_DATABASE_URL as string);
        const channels = new ChannelRepository(handle.db);
        const stamp = Date.now();

        alphaId = (await channels.upsert({
            twitchBroadcasterId: `red-a-${stamp}`, twitchLogin: 'redalpha', displayName: null
        })).id;
        betaId = (await channels.upsert({
            twitchBroadcasterId: `red-b-${stamp}`, twitchLogin: 'redbeta', displayName: null
        })).id;

        // Deliberately different reward ids for the same kind, which is the
        // real-world case: every channel's rewards are its own.
        await new ChannelRewardRepository(handle.db, alphaId)
            .upsert({ kind: 'add_quote', rewardId: 'alpha-quote-reward', title: 'Add a quote' });
        await new ChannelRewardRepository(handle.db, betaId)
            .upsert({ kind: 'add_quote', rewardId: 'beta-quote-reward', title: 'Add a quote' });
    }, 60_000);

    afterAll(async () => {
        await handle?.close();
    });

    beforeEach(() => {
        settled = [];
        sent = [];
    });

    const buildPipeline = (channelId: string): RedemptionPipeline =>
        new RedemptionPipeline({
            channelId,
            rewards: new ChannelRewardRepository(handle.db, channelId),
            settlement: settlementStub(),
            handlers: {
                add_quote: createQuoteRedemptionHandler({
                    quotes: new QuoteRepository(handle.db, channelId),
                    logger
                })
            },
            logger,
            sendMessage: async (text) => { sent.push(text); }
        });

    describe('routing', () => {
        it('leaves an unmanaged reward completely alone', async () => {
            // "Pick the game" and "MS paint" are the broadcaster's own. Touching
            // their status would be taking over something we were never asked
            // to run.
            const outcome = await buildPipeline(alphaId).handle(
                redemption({ rewardId: 'not-ours', rewardTitle: 'Pick the game' })
            );

            expect(outcome).toEqual({ action: 'ignored', reason: 'unmanaged_reward' });
            expect(settled).toHaveLength(0);
            expect(sent).toHaveLength(0);
        });

        it('routes by reward id, not by title', async () => {
            // A reward renamed in the dashboard keeps working - the Phase-0 bug
            // this design exists to prevent.
            const outcome = await buildPipeline(alphaId).handle(redemption({
                rewardId: 'alpha-quote-reward',
                rewardTitle: 'Completely Different Name Now',
                userInput: '"Renamed but still working" - Someone'
            }));

            expect(outcome).toMatchObject({ action: 'fulfilled', kind: 'add_quote' });
        });

        it('refunds a managed reward with no handler rather than keeping the points', async () => {
            const pipeline = new RedemptionPipeline({
                channelId: alphaId,
                rewards: new ChannelRewardRepository(handle.db, alphaId),
                settlement: settlementStub(),
                handlers: {},
                logger,
                sendMessage: async (t) => { sent.push(t); }
            });

            const outcome = await pipeline.handle(redemption({ rewardId: 'alpha-quote-reward' }));

            expect(outcome).toEqual({ action: 'ignored', reason: 'no_handler' });
            expect(settled).toEqual([{ status: 'CANCELED', redemptionId: 'redemption-1' }]);
        });
    });

    describe('the fulfil-or-refund invariant', () => {
        it('fulfils a valid quote and stores it', async () => {
            const outcome = await buildPipeline(alphaId).handle(redemption({
                rewardId: 'alpha-quote-reward',
                userInput: '"A real quote" - A Real Person'
            }));

            expect(outcome).toMatchObject({ action: 'fulfilled' });
            expect(settled).toEqual([{ status: 'FULFILLED', redemptionId: 'redemption-1' }]);
            expect(sent[0]).toContain('A real quote');
        });

        it('refunds a malformed quote and says why', async () => {
            const outcome = await buildPipeline(alphaId).handle(redemption({
                rewardId: 'alpha-quote-reward',
                userInput: 'no quotes and no author here'
            }));

            expect(outcome).toMatchObject({ action: 'refunded' });
            expect(settled).toEqual([{ status: 'CANCELED', redemptionId: 'redemption-1' }]);
            expect(sent[0]).toContain('refunded');
        });

        it('refunds empty input', async () => {
            const outcome = await buildPipeline(alphaId).handle(redemption({
                rewardId: 'alpha-quote-reward', userInput: '   '
            }));

            expect(outcome).toMatchObject({ action: 'refunded' });
            expect(settled[0]?.status).toBe('CANCELED');
        });

        it('refunds when the handler throws rather than leaving points taken', async () => {
            const pipeline = new RedemptionPipeline({
                channelId: alphaId,
                rewards: new ChannelRewardRepository(handle.db, alphaId),
                settlement: settlementStub(),
                handlers: { add_quote: async () => { throw new Error('storage exploded'); } },
                logger,
                sendMessage: async (t) => { sent.push(t); }
            });

            const outcome = await pipeline.handle(redemption({
                rewardId: 'alpha-quote-reward', userInput: '"valid" - person'
            }));

            expect(outcome).toMatchObject({ action: 'refunded' });
            expect(settled).toEqual([{ status: 'CANCELED', redemptionId: 'redemption-1' }]);
        });

        it('still refunds when chat is unavailable', async () => {
            // The refund already ran; a failing sendMessage must not undo it.
            const pipeline = new RedemptionPipeline({
                channelId: alphaId,
                rewards: new ChannelRewardRepository(handle.db, alphaId),
                settlement: settlementStub(),
                handlers: { add_quote: async () => 'nope' },
                logger,
                sendMessage: async () => { throw new Error('chat down'); }
            });

            await expect(pipeline.handle(redemption({ rewardId: 'alpha-quote-reward' })))
                .resolves.toMatchObject({ action: 'refunded' });
            expect(settled[0]?.status).toBe('CANCELED');
        });

        it('never throws out of handle(), whatever happens', async () => {
            // A redemption that throws into the session would stop the channel
            // processing everything after it.
            const pipeline = new RedemptionPipeline({
                channelId: alphaId,
                rewards: new ChannelRewardRepository(handle.db, alphaId),
                settlement: {
                    settle: async () => { throw new Error('twitch down'); }
                } as unknown as RedemptionSettlement,
                handlers: { add_quote: async () => 'refund me' },
                logger,
                sendMessage: async (t) => { sent.push(t); }
            });

            await expect(pipeline.handle(redemption({ rewardId: 'alpha-quote-reward' })))
                .resolves.toMatchObject({ action: 'refunded' });
        });
    });

    describe('THE CENTREPIECE: two channels, isolated redemptions', () => {
        it('does not act on another channel reward id', async () => {
            // Beta's reward arriving at alpha's pipeline is unmanaged there.
            const outcome = await buildPipeline(alphaId).handle(
                redemption({ rewardId: 'beta-quote-reward', userInput: '"x" - y' })
            );

            expect(outcome).toEqual({ action: 'ignored', reason: 'unmanaged_reward' });
            expect(settled).toHaveLength(0);
        });

        it('stores each channel quotes separately', async () => {
            await buildPipeline(alphaId).handle(redemption({
                rewardId: 'alpha-quote-reward', userInput: '"alpha quote" - a'
            }));
            await buildPipeline(betaId).handle(redemption({
                rewardId: 'beta-quote-reward', userInput: '"beta quote" - b'
            }));

            const alphaQuotes = await new QuoteRepository(handle.db, alphaId).list(50, 0);
            const betaQuotes = await new QuoteRepository(handle.db, betaId).list(50, 0);

            expect(alphaQuotes.some((q) => q.quoteText === 'alpha quote')).toBe(true);
            expect(alphaQuotes.some((q) => q.quoteText === 'beta quote')).toBe(false);
            expect(betaQuotes.some((q) => q.quoteText === 'beta quote')).toBe(true);
        });
    });

    /**
     * The write that was never there.
     *
     * Before this, the redemption path recorded no analytics at all: the
     * dashboard's "points redeemed" tile read zero forever, and so did every
     * viewer's lifetime `redemption_count` — a column that had been in the
     * schema, and empty, since it was added.
     *
     * Against the real database on purpose. The risk in this write is not the
     * arithmetic, it is the foreign key: `chat_messages.twitch_user_id`
     * references `viewers` with RESTRICT, and someone can redeem a reward
     * without ever having typed in chat. A stub would have proved nothing about
     * the one thing that could fail.
     */
    describe('the points-redeemed write', () => {
        const pipelineWithAnalytics = (
            channelId: string,
            options: { streamId?: string | null } = {}
        ): RedemptionPipeline =>
            new RedemptionPipeline({
                channelId,
                rewards: new ChannelRewardRepository(handle.db, channelId),
                settlement: settlementStub(),
                handlers: {
                    add_quote: createQuoteRedemptionHandler({
                        quotes: new QuoteRepository(handle.db, channelId),
                        logger
                    })
                },
                logger,
                sendMessage: async (text) => { sent.push(text); },
                analytics: new DatabaseAnalyticsSink({
                    analytics: new AnalyticsRepository(handle.db, channelId)
                }),
                history: new ChatHistoryRepository(handle.db, channelId),
                roles: new ChannelRoleRepository(handle.db, channelId),
                currentStreamId: () => options.streamId ?? null
            });

        const redemptionsFor = async (channelId: string, streamId: string): Promise<number> =>
            (await new DashboardRepository(handle.db, channelId).numbersForStream(streamId))
                .pointsRedeemed;

        it('counts a fulfilled redemption against the stream it happened in', async () => {
            const streamId = (await new StreamRepository(handle.db, alphaId).open({
                twitchStreamId: `points-${Date.now()}`,
                startedAt: new Date(),
                title: null,
                category: null
            })).id;

            await pipelineWithAnalytics(alphaId, { streamId }).handle(redemption({
                rewardId: 'alpha-quote-reward',
                redeemer: { twitchUserId: 'points-viewer', login: 'pointsviewer', displayName: 'P' },
                userInput: '"counted" - someone'
            }));

            expect(await redemptionsFor(alphaId, streamId)).toBe(1);
        });

        it('records a redeemer who has never chatted', async () => {
            // The foreign key case, and the reason presence is written first.
            // A viewer can spend points on their very first interaction with a
            // channel, and an insert that assumed the chat path had already
            // created them would fail on RESTRICT and lose the count.
            const streamId = (await new StreamRepository(handle.db, alphaId).open({
                twitchStreamId: `fk-${Date.now()}`,
                startedAt: new Date(),
                title: null,
                category: null
            })).id;
            const stranger = `stranger-${Date.now()}`;

            await pipelineWithAnalytics(alphaId, { streamId }).handle(redemption({
                rewardId: 'alpha-quote-reward',
                redeemer: { twitchUserId: stranger, login: 'stranger', displayName: 'S' },
                userInput: '"first ever interaction" - nobody'
            }));

            expect(await redemptionsFor(alphaId, streamId)).toBe(1);
        });

        it('rolls into the viewer lifetime totals, which were never counted before', async () => {
            // `redemption_count` has been in `chat_totals` since it was added
            // and no code path had ever incremented it. This is the assertion
            // that the column now means something.
            const stamp = Date.now();
            const login = `lifetime${stamp}`;

            await pipelineWithAnalytics(alphaId).handle(redemption({
                rewardId: 'alpha-quote-reward',
                redeemer: { twitchUserId: `lifetime-${stamp}`, login, displayName: 'L' },
                userInput: '"lifetime" - someone'
            }));

            const totals = await new AnalyticsRepository(handle.db, alphaId).totalsForLogin(login);

            expect(totals?.redemptionCount).toBe(1);
            // Counted as an interaction, but NOT as a chat message: spending
            // points is not a line of chat, and reporting it as one would
            // inflate "messages this stream" by every reward redeemed.
            expect(totals?.messageCount).toBe(0);
            expect(totals?.totalCount).toBe(1);
        });

        it('does NOT count a refunded redemption', async () => {
            // The points went back. Counting a refund as a spend would report a
            // number the broadcaster can never reconcile against Twitch.
            const streamId = (await new StreamRepository(handle.db, alphaId).open({
                twitchStreamId: `refund-${Date.now()}`,
                startedAt: new Date(),
                title: null,
                category: null
            })).id;

            await pipelineWithAnalytics(alphaId, { streamId }).handle(redemption({
                rewardId: 'alpha-quote-reward',
                redeemer: { twitchUserId: 'refund-viewer', login: 'refundviewer', displayName: 'R' },
                // Malformed: the handler refuses and the pipeline refunds.
                userInput: 'not a quote at all'
            }));

            expect(settled).toEqual([{ status: 'CANCELED', redemptionId: 'redemption-1' }]);
            expect(await redemptionsFor(alphaId, streamId)).toBe(0);
        });

        it('does NOT count an unmanaged reward', async () => {
            // The broadcaster's own rewards are not the bot's to report on.
            const streamId = (await new StreamRepository(handle.db, alphaId).open({
                twitchStreamId: `unmanaged-${Date.now()}`,
                startedAt: new Date(),
                title: null,
                category: null
            })).id;

            await pipelineWithAnalytics(alphaId, { streamId }).handle(redemption({
                rewardId: 'not-ours',
                rewardTitle: 'Pick the game',
                redeemer: { twitchUserId: 'unmanaged-viewer', login: 'unmanagedviewer', displayName: 'U' }
            }));

            expect(await redemptionsFor(alphaId, streamId)).toBe(0);
        });

        it('serves the viewer even when the analytics write fails', async () => {
            // Bookkeeping must never turn a successful redemption into a failed
            // one — the same rule the chat path follows.
            const pipeline = new RedemptionPipeline({
                channelId: alphaId,
                rewards: new ChannelRewardRepository(handle.db, alphaId),
                settlement: settlementStub(),
                handlers: {
                    add_quote: createQuoteRedemptionHandler({
                        quotes: new QuoteRepository(handle.db, alphaId),
                        logger
                    })
                },
                logger,
                sendMessage: async (text) => { sent.push(text); },
                analytics: {
                    recordInteraction: async () => { throw new Error('analytics down'); }
                },
                roles: new ChannelRoleRepository(handle.db, alphaId)
            });

            await expect(pipeline.handle(redemption({
                rewardId: 'alpha-quote-reward',
                redeemer: { twitchUserId: 'resilient-viewer', login: 'resilient', displayName: 'R' },
                userInput: '"still stored" - someone'
            }))).resolves.toMatchObject({ action: 'fulfilled' });

            expect(settled).toEqual([{ status: 'FULFILLED', redemptionId: 'redemption-1' }]);
        });

        it('keeps one channel redemptions out of another count', async () => {
            const alphaStream = (await new StreamRepository(handle.db, alphaId).open({
                twitchStreamId: `iso-a-${Date.now()}`,
                startedAt: new Date(), title: null, category: null
            })).id;
            const betaStream = (await new StreamRepository(handle.db, betaId).open({
                twitchStreamId: `iso-b-${Date.now()}`,
                startedAt: new Date(), title: null, category: null
            })).id;

            await pipelineWithAnalytics(alphaId, { streamId: alphaStream }).handle(redemption({
                rewardId: 'alpha-quote-reward',
                redeemer: { twitchUserId: 'iso-viewer', login: 'isoviewer', displayName: 'I' },
                userInput: '"alpha only" - someone'
            }));

            expect(await redemptionsFor(alphaId, alphaStream)).toBe(1);
            expect(await redemptionsFor(betaId, betaStream)).toBe(0);
        });
    });
});
