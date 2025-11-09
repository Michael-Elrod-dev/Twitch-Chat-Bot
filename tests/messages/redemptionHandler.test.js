// tests/messages/redemptionHandler.test.js

const RedemptionHandler = require('../../src/messages/redemptionHandler');

// Mock logger
jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const logger = require('../../src/logger/logger');

describe('RedemptionHandler', () => {
    let redemptionHandler;
    let mockViewerManager;
    let mockRedemptionManager;
    let mockBot;

    beforeEach(() => {
        jest.clearAllMocks();

        mockViewerManager = {
            trackViewer: jest.fn()
        };

        mockRedemptionManager = {
            handleRedemption: jest.fn().mockResolvedValue(true)
        };

        mockBot = {
            analyticsManager: {
                trackChatMessage: jest.fn().mockResolvedValue(true)
            },
            currentStreamId: 'stream-123'
        };

        redemptionHandler = new RedemptionHandler(mockViewerManager, mockRedemptionManager);
    });

    describe('constructor', () => {
        it('should initialize with viewer and redemption managers', () => {
            expect(redemptionHandler.viewerManager).toBe(mockViewerManager);
            expect(redemptionHandler.redemptionManager).toBe(mockRedemptionManager);
        });
    });

    describe('handleRedemption', () => {
        const createRedemptionPayload = (overrides = {}) => {
            const basePayload = {
                event: {
                    reward: {
                        title: 'Test Reward',
                        id: 'reward-123'
                    },
                    user_login: 'testuser',
                    user_id: 'user-456',
                    user_input: 'Test input',
                    status: 'fulfilled',
                    id: 'redemption-789',
                    broadcaster_user_id: 'broadcaster-999',
                    broadcaster_user_login: 'broadcaster'
                }
            };

            if (overrides.event) {
                basePayload.event = { ...basePayload.event, ...overrides.event };
            }
            if (overrides.reward) {
                basePayload.event.reward = { ...basePayload.event.reward, ...overrides.reward };
            }

            return basePayload;
        };

        it('should process complete redemption successfully', async () => {
            const payload = createRedemptionPayload();

            await redemptionHandler.handleRedemption(payload, mockBot);

            expect(logger.info).toHaveBeenCalledWith(
                'RedemptionHandler',
                'Processing channel point redemption',
                expect.objectContaining({
                    userId: 'user-456',
                    userName: 'testuser',
                    rewardTitle: 'Test Reward',
                    rewardId: 'reward-123',
                    input: 'Test input'
                })
            );

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'testuser',
                'user-456',
                'stream-123',
                'Test input',
                'redemption',
                {}
            );

            expect(mockRedemptionManager.handleRedemption).toHaveBeenCalledWith(
                expect.objectContaining({
                    rewardTitle: 'Test Reward',
                    rewardId: 'reward-123',
                    userDisplayName: 'testuser',
                    userId: 'user-456',
                    input: 'Test input',
                    status: 'fulfilled',
                    id: 'redemption-789',
                    broadcasterId: 'broadcaster-999',
                    broadcasterDisplayName: 'broadcaster'
                })
            );

            expect(logger.info).toHaveBeenCalledWith(
                'RedemptionHandler',
                'Redemption processed successfully',
                expect.objectContaining({
                    userId: 'user-456',
                    userName: 'testuser',
                    rewardTitle: 'Test Reward'
                })
            );
        });

        it('should return early when payload has no event', async () => {
            await redemptionHandler.handleRedemption({}, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).not.toHaveBeenCalled();
            expect(mockRedemptionManager.handleRedemption).not.toHaveBeenCalled();
        });

        it('should return early when payload is null', async () => {
            await redemptionHandler.handleRedemption(null, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).not.toHaveBeenCalled();
            expect(mockRedemptionManager.handleRedemption).not.toHaveBeenCalled();
        });

        it('should handle redemption without user input', async () => {
            const payload = createRedemptionPayload({
                event: { user_input: null }
            });

            await redemptionHandler.handleRedemption(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'testuser',
                'user-456',
                'stream-123',
                'Test Reward', // Falls back to reward title
                'redemption',
                {}
            );

            expect(mockRedemptionManager.handleRedemption).toHaveBeenCalledWith(
                expect.objectContaining({
                    input: null
                })
            );
        });

        it('should handle redemption with empty user input', async () => {
            const payload = createRedemptionPayload({
                event: { user_input: '' }
            });

            await redemptionHandler.handleRedemption(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'testuser',
                'user-456',
                'stream-123',
                'Test Reward',
                'redemption',
                {}
            );
        });

        it('should handle redemption with unfulfilled status', async () => {
            const payload = createRedemptionPayload({
                event: { status: 'unfulfilled' }
            });

            await redemptionHandler.handleRedemption(payload, mockBot);

            expect(mockRedemptionManager.handleRedemption).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 'unfulfilled'
                })
            );
        });

        it('should handle redemption with canceled status', async () => {
            const payload = createRedemptionPayload({
                event: { status: 'canceled' }
            });

            await redemptionHandler.handleRedemption(payload, mockBot);

            expect(mockRedemptionManager.handleRedemption).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 'canceled'
                })
            );
        });

        it('should handle analytics tracking error gracefully', async () => {
            const payload = createRedemptionPayload();
            const analyticsError = new Error('Analytics DB error');
            analyticsError.stack = 'Error stack';
            mockBot.analyticsManager.trackChatMessage.mockRejectedValue(analyticsError);

            await redemptionHandler.handleRedemption(payload, mockBot);

            expect(logger.error).toHaveBeenCalledWith(
                'RedemptionHandler',
                'Error handling redemption',
                expect.objectContaining({
                    error: 'Analytics DB error'
                })
            );
        });

        it('should handle redemption manager error gracefully', async () => {
            const payload = createRedemptionPayload();
            const redemptionError = new Error('Redemption processing failed');
            redemptionError.stack = 'Error stack';
            mockRedemptionManager.handleRedemption.mockRejectedValue(redemptionError);

            await redemptionHandler.handleRedemption(payload, mockBot);

            expect(logger.error).toHaveBeenCalledWith(
                'RedemptionHandler',
                'Error handling redemption',
                expect.objectContaining({
                    error: 'Redemption processing failed'
                })
            );
        });

        it('should not throw on error', async () => {
            const payload = createRedemptionPayload();
            mockRedemptionManager.handleRedemption.mockRejectedValue(new Error('Test error'));

            await expect(
                redemptionHandler.handleRedemption(payload, mockBot)
            ).resolves.not.toThrow();
        });

        it('should handle long user input', async () => {
            const longInput = 'A'.repeat(500);
            const payload = createRedemptionPayload({
                event: { user_input: longInput }
            });

            await redemptionHandler.handleRedemption(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'testuser',
                'user-456',
                'stream-123',
                longInput,
                'redemption',
                {}
            );
        });

        it('should handle special characters in input', async () => {
            const specialInput = 'Test with "quotes" and \\backslashes\\ and 😀 emoji';
            const payload = createRedemptionPayload({
                event: { user_input: specialInput }
            });

            await redemptionHandler.handleRedemption(payload, mockBot);

            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledWith(
                'testuser',
                'user-456',
                'stream-123',
                specialInput,
                'redemption',
                {}
            );
        });

        it('should handle different reward types', async () => {
            const rewardTitles = [
                'Song Request',
                'Quote Add',
                'Hydrate',
                'TTS Message'
            ];

            for (const title of rewardTitles) {
                const payload = createRedemptionPayload({
                    event: {
                        reward: { title }
                    }
                });

                await redemptionHandler.handleRedemption(payload, mockBot);

                expect(mockRedemptionManager.handleRedemption).toHaveBeenCalledWith(
                    expect.objectContaining({
                        rewardTitle: title
                    })
                );
            }
        });

        it('should pass correct event structure to redemption manager', async () => {
            const payload = createRedemptionPayload();

            await redemptionHandler.handleRedemption(payload, mockBot);

            const passedEvent = mockRedemptionManager.handleRedemption.mock.calls[0][0];

            expect(passedEvent).toMatchObject({
                rewardTitle: 'Test Reward',
                rewardId: 'reward-123',
                userDisplayName: 'testuser',
                userId: 'user-456',
                input: 'Test input',
                status: 'fulfilled',
                id: 'redemption-789',
                broadcasterId: 'broadcaster-999',
                broadcasterDisplayName: 'broadcaster'
            });
        });

        it('should log all redemption details', async () => {
            const payload = createRedemptionPayload({
                event: {
                    reward: {
                        title: 'Custom Reward',
                        id: 'custom-123'
                    },
                    user_login: 'customuser',
                    user_id: 'custom-456',
                    user_input: 'Custom input'
                }
            });

            await redemptionHandler.handleRedemption(payload, mockBot);

            expect(logger.info).toHaveBeenCalledWith(
                'RedemptionHandler',
                'Processing channel point redemption',
                {
                    userId: 'custom-456',
                    userName: 'customuser',
                    rewardTitle: 'Custom Reward',
                    rewardId: 'custom-123',
                    input: 'Custom input'
                }
            );
        });
    });

    describe('Integration scenarios', () => {
        it('should handle multiple redemptions in sequence', async () => {
            const createPayload = (index) => ({
                event: {
                    reward: { title: `Reward ${index}`, id: `reward-${index}` },
                    user_login: `user${index}`,
                    user_id: `user-id-${index}`,
                    user_input: `Input ${index}`,
                    status: 'fulfilled',
                    id: `redemption-${index}`,
                    broadcaster_user_id: 'broadcaster-999',
                    broadcaster_user_login: 'broadcaster'
                }
            });

            await redemptionHandler.handleRedemption(createPayload(1), mockBot);
            await redemptionHandler.handleRedemption(createPayload(2), mockBot);
            await redemptionHandler.handleRedemption(createPayload(3), mockBot);

            expect(mockRedemptionManager.handleRedemption).toHaveBeenCalledTimes(3);
            expect(mockBot.analyticsManager.trackChatMessage).toHaveBeenCalledTimes(3);
        });

        it('should continue processing after error in one redemption', async () => {
            const payload1 = {
                event: {
                    reward: { title: 'Reward 1', id: 'reward-1' },
                    user_login: 'user1',
                    user_id: 'user-1',
                    user_input: 'Input 1',
                    status: 'fulfilled',
                    id: 'redemption-1',
                    broadcaster_user_id: 'broadcaster-999',
                    broadcaster_user_login: 'broadcaster'
                }
            };

            const payload2 = {
                event: {
                    reward: { title: 'Reward 2', id: 'reward-2' },
                    user_login: 'user2',
                    user_id: 'user-2',
                    user_input: 'Input 2',
                    status: 'fulfilled',
                    id: 'redemption-2',
                    broadcaster_user_id: 'broadcaster-999',
                    broadcaster_user_login: 'broadcaster'
                }
            };

            // First redemption fails
            mockRedemptionManager.handleRedemption
                .mockRejectedValueOnce(new Error('Processing failed'))
                .mockResolvedValueOnce(true);

            await redemptionHandler.handleRedemption(payload1, mockBot);
            await redemptionHandler.handleRedemption(payload2, mockBot);

            expect(mockRedemptionManager.handleRedemption).toHaveBeenCalledTimes(2);
            expect(logger.error).toHaveBeenCalled();
        });
    });
});
