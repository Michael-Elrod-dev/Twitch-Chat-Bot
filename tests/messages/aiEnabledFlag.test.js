/**
 * P1-6: AI flag latency and fail direction.
 */

describe('P1-6: AI enabled flag', () => {
    const ChatMessageHandler = require('../../src/messages/chatMessageHandler');
    let handler;
    let cacheManager;
    let redisManager;
    let bot;

    beforeEach(() => {
        cacheManager = {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(true),
            del: jest.fn().mockResolvedValue(true)
        };
        redisManager = {
            connected: jest.fn().mockReturnValue(true),
            getCacheManager: jest.fn(() => cacheManager)
        };
        bot = {
            analyticsManager: { dbManager: { query: jest.fn().mockResolvedValue([]) } }
        };
        handler = new ChatMessageHandler({}, {}, {}, {}, redisManager);
    });

    it('should fail CLOSED when the flag cannot be read', async () => {
        bot.analyticsManager.dbManager.query.mockRejectedValue(new Error('DB down'));

        // Deliberate behaviour change: an outage silences the AI rather than
        // re-enabling one the broadcaster switched off.
        await expect(handler.isAIEnabled(bot)).resolves.toBe(false);
    });

    it('should default to enabled when no row exists', async () => {
        bot.analyticsManager.dbManager.query.mockResolvedValue([]);

        await expect(handler.isAIEnabled(bot)).resolves.toBe(true);
    });

    it('should honour a stored false', async () => {
        bot.analyticsManager.dbManager.query.mockResolvedValue([{ token_value: 'false' }]);

        await expect(handler.isAIEnabled(bot)).resolves.toBe(false);
    });

    it('should invalidate the cache when the toggle is used', async () => {
        const aiHandlers = require('../../src/commands/handlers/ai');
        const handlers = aiHandlers({ redisManager });

        const twitchBot = {
            sendMessage: jest.fn().mockResolvedValue(undefined),
            analyticsManager: {
                dbManager: {
                    query: jest.fn()
                        .mockResolvedValueOnce([{ token_value: 'true' }])
                        .mockResolvedValueOnce({ affectedRows: 1 })
                }
            },
            redisManager
        };

        await handlers.toggleAI(twitchBot, 'chan', { mod: true, badges: {} }, ['off']);

        // Without invalidation the toggle took up to the cache TTL to take effect.
        expect(cacheManager.del).toHaveBeenCalledWith('cache:settings:aiEnabled');
    });
});
