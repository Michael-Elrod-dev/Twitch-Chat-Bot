/**
 * handleGameCommand backs !advice and !roast. It was the least-covered non-trivial
 * path in src/ after the Phase 0 packages, so this file covers it directly.
 */

const AIManager = require('../../src/ai/aiManager');

jest.mock('../../src/ai/rateLimiter');
jest.mock('../../src/ai/contextBuilder');
jest.mock('../../src/ai/promptBuilder');
jest.mock('../../src/ai/models/claudeModel');

const RateLimiter = require('../../src/ai/rateLimiter');
const ContextBuilder = require('../../src/ai/contextBuilder');
const PromptBuilder = require('../../src/ai/promptBuilder');
const ClaudeModel = require('../../src/ai/models/claudeModel');

describe('AIManager - handleGameCommand', () => {
    let aiManager;
    let rateLimiter;
    let contextBuilder;
    let promptBuilder;
    let claudeModel;

    const requester = {
        userId: 'req-1',
        userName: 'requester',
        isMod: true,
        isBroadcaster: false
    };

    beforeEach(async () => {
        jest.clearAllMocks();

        rateLimiter = {
            checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
            updateUsage: jest.fn().mockResolvedValue(undefined),
            getUserStats: jest.fn().mockResolvedValue({ streamCount: 3 }),
            getUserLimits: jest.fn().mockReturnValue({ streamLimit: 15 })
        };
        RateLimiter.mockImplementation(() => rateLimiter);

        contextBuilder = {
            getAllContext: jest.fn().mockResolvedValue({
                streamContext: { title: 'Test Stream' },
                chatHistory: [],
                userRoles: { broadcaster: 'bc', mods: [] }
            }),
            getUserProfile: jest.fn().mockResolvedValue({ messages: 42 })
        };
        ContextBuilder.mockImplementation(() => contextBuilder);

        promptBuilder = {
            buildUserMessage: jest.fn().mockReturnValue('user message'),
            buildGamePrompt: jest.fn().mockReturnValue('game prompt')
        };
        PromptBuilder.mockImplementation(() => promptBuilder);

        claudeModel = {
            getTextResponse: jest.fn().mockResolvedValue('a witty response')
        };
        ClaudeModel.mockImplementation(() => claudeModel);

        aiManager = new AIManager();
        await aiManager.init({ query: jest.fn() }, 'api-key', null);
    });

    describe('happy path', () => {
        it('should return the model response', async () => {
            const result = await aiManager.handleGameCommand(
                'roast', 'target-1', 'targetuser', 'stream-1', requester
            );

            expect(result).toEqual({ success: true, response: 'a witty response' });
        });

        it('should build the prompt from the target profile and stream context', async () => {
            await aiManager.handleGameCommand('advice', 'target-1', 'targetuser', 'stream-1', requester);

            expect(contextBuilder.getUserProfile).toHaveBeenCalledWith('target-1');
            expect(promptBuilder.buildGamePrompt).toHaveBeenCalledWith(
                'targetuser',
                { messages: 42 },
                { title: 'Test Stream' },
                [],
                { broadcaster: 'bc', mods: [] }
            );
        });

        it('should combine the chat prompt with the game-specific prompt', async () => {
            await aiManager.handleGameCommand('roast', 'target-1', 'targetuser', 'stream-1', requester);

            const [, , systemPrompt] = claudeModel.getTextResponse.mock.calls[0];
            expect(systemPrompt.length).toBeGreaterThan(0);
            expect(systemPrompt).toContain('\n\n');
        });

        it('should charge the REQUESTER, not the target', async () => {
            await aiManager.handleGameCommand('roast', 'target-1', 'targetuser', 'stream-1', requester);

            expect(rateLimiter.updateUsage).toHaveBeenCalledWith('req-1', 'claude', 'stream-1');
        });

        it('should not prefix the response with a usage counter', async () => {
            const result = await aiManager.handleGameCommand(
                'roast', 'target-1', 'targetuser', 'stream-1', requester
            );

            // Unlike handleTextRequest, game commands return the bare response.
            expect(result.response).toBe('a witty response');
        });

        it('should use the configured history limit for the game type', async () => {
            await aiManager.handleGameCommand('advice', 'target-1', 'targetuser', 'stream-1', requester);

            expect(contextBuilder.getAllContext).toHaveBeenCalledWith('stream-1', 0);
        });

        it('should fetch context and profile together', async () => {
            await aiManager.handleGameCommand('roast', 'target-1', 'targetuser', 'stream-1', requester);

            expect(contextBuilder.getAllContext).toHaveBeenCalled();
            expect(contextBuilder.getUserProfile).toHaveBeenCalled();
        });
    });

    describe('rate limiting', () => {
        it('should refuse when the requester is over their limit', async () => {
            rateLimiter.checkRateLimit.mockResolvedValue({
                allowed: false,
                reason: 'stream_limit',
                message: 'You have hit your limit'
            });

            const result = await aiManager.handleGameCommand(
                'roast', 'target-1', 'targetuser', 'stream-1', requester
            );

            expect(result).toEqual({ success: false, message: 'You have hit your limit' });
        });

        it('should not call the model when rate limited', async () => {
            rateLimiter.checkRateLimit.mockResolvedValue({ allowed: false, message: 'nope' });

            await aiManager.handleGameCommand('roast', 'target-1', 'targetuser', 'stream-1', requester);

            expect(claudeModel.getTextResponse).not.toHaveBeenCalled();
        });

        it('should not charge usage when rate limited', async () => {
            rateLimiter.checkRateLimit.mockResolvedValue({ allowed: false, message: 'nope' });

            await aiManager.handleGameCommand('roast', 'target-1', 'targetuser', 'stream-1', requester);

            expect(rateLimiter.updateUsage).not.toHaveBeenCalled();
        });
    });

    describe('failure paths', () => {
        it('should report an unavailable game type', async () => {
            const result = await aiManager.handleGameCommand(
                'nonexistent', 'target-1', 'targetuser', 'stream-1', requester
            );

            expect(result).toEqual({ success: false, message: 'Game type not available.' });
        });

        it('should not call the model for an unknown game type', async () => {
            await aiManager.handleGameCommand('nonexistent', 'target-1', 'targetuser', 'stream-1', requester);

            expect(claudeModel.getTextResponse).not.toHaveBeenCalled();
        });

        it('should report an empty model response as unavailable', async () => {
            claudeModel.getTextResponse.mockResolvedValue(null);

            const result = await aiManager.handleGameCommand(
                'roast', 'target-1', 'targetuser', 'stream-1', requester
            );

            expect(result.success).toBe(false);
            expect(result.message).toBeDefined();
        });

        it('should not charge usage when the model returns nothing', async () => {
            claudeModel.getTextResponse.mockResolvedValue(null);

            await aiManager.handleGameCommand('roast', 'target-1', 'targetuser', 'stream-1', requester);

            expect(rateLimiter.updateUsage).not.toHaveBeenCalled();
        });
    });
});
