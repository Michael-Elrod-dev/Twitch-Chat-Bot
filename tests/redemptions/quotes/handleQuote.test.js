// tests/redemptions/quotes/handleQuote.test.js

const handleQuote = require('../../../src/redemptions/quotes/handleQuote');

describe('handleQuote', () => {
    let mockTwitchBot;
    let event;

    beforeEach(() => {
        jest.clearAllMocks();

        mockTwitchBot = {
            quoteManager: {
                dbManager: {},
                init: jest.fn().mockResolvedValue(true),
                addQuote: jest.fn().mockResolvedValue(123)
            },
            redemptionManager: {
                updateRedemptionStatus: jest.fn().mockResolvedValue(true)
            },
            sendMessage: jest.fn().mockResolvedValue(true),
            analyticsManager: {
                dbManager: {}
            }
        };

        event = {
            input: '"Test quote" - Test Author',
            userId: 'user-123',
            userDisplayName: 'testuser',
            broadcasterId: 'broadcaster-456',
            broadcasterDisplayName: 'streamer',
            rewardId: 'reward-789',
            id: 'redemption-abc'
        };
    });

    describe('Valid quote submissions', () => {
        it('should save quote with double quotes successfully', async () => {
            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.quoteManager.addQuote).toHaveBeenCalledWith({
                quote: 'Test quote',
                author: 'Test Author',
                savedBy: 'testuser',
                userId: 'user-123'
            });

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'FULFILLED'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                'Quote #123 has been saved! "Test quote" - Test Author'
            );
        });

        it('should save quote with single quotes', async () => {
            event.input = '\'Test quote\' - Test Author';

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.quoteManager.addQuote).toHaveBeenCalledWith(
                expect.objectContaining({
                    quote: 'Test quote',
                    author: 'Test Author'
                })
            );
        });

        it('should save quote with curly double quotes', async () => {
            event.input = '\u201CTest quote\u201D - Test Author';

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.quoteManager.addQuote).toHaveBeenCalledWith(
                expect.objectContaining({
                    quote: 'Test quote',
                    author: 'Test Author'
                })
            );
        });

        it('should save quote with curly single quotes', async () => {
            event.input = '\u2018Test quote\u2019 - Test Author';

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.quoteManager.addQuote).toHaveBeenCalledWith(
                expect.objectContaining({
                    quote: 'Test quote',
                    author: 'Test Author'
                })
            );
        });

        it('should trim whitespace from quote and author', async () => {
            event.input = '"  Spaced quote  "  -  Spaced Author  ';

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.quoteManager.addQuote).toHaveBeenCalledWith(
                expect.objectContaining({
                    quote: 'Spaced quote',
                    author: 'Spaced Author'
                })
            );
        });

        it('should handle long quotes', async () => {
            const longQuote = 'A'.repeat(500);
            event.input = `"${longQuote}" - Long Author`;

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.quoteManager.addQuote).toHaveBeenCalledWith(
                expect.objectContaining({
                    quote: longQuote,
                    author: 'Long Author'
                })
            );
        });

        it('should initialize quoteManager if not initialized', async () => {
            mockTwitchBot.quoteManager.dbManager = null;

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.quoteManager.init).toHaveBeenCalledWith(
                mockTwitchBot.analyticsManager.dbManager
            );
        });
    });

    describe('Empty input validation', () => {
        it('should cancel redemption when input is empty', async () => {
            event.input = '';

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                '@testuser Please provide a quote in the format: "Quote" - Person who said it. Your points have been refunded.'
            );

            expect(mockTwitchBot.quoteManager.addQuote).not.toHaveBeenCalled();
        });

        it('should cancel redemption when input is only whitespace', async () => {
            event.input = '   ';

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );

            expect(mockTwitchBot.quoteManager.addQuote).not.toHaveBeenCalled();
        });
    });

    describe('Format validation', () => {
        it('should cancel redemption when missing quotes', async () => {
            event.input = 'Quote without quotes - Author';

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                '@testuser Invalid format. Please use: "Quote" - Person who said it. Your points have been refunded.'
            );

            expect(mockTwitchBot.quoteManager.addQuote).not.toHaveBeenCalled();
        });

        it('should cancel redemption when missing dash separator', async () => {
            event.input = '"Quote" Author';

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );
        });

        it('should cancel redemption when missing author', async () => {
            event.input = '"Quote"';

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );
        });

        it('should cancel redemption when only opening quote', async () => {
            event.input = '"Quote - Author';

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.quoteManager.addQuote).not.toHaveBeenCalled();
        });
    });

    describe('Database error handling', () => {
        it('should cancel redemption when database save fails', async () => {
            const saveError = new Error('Database connection failed');
            saveError.stack = 'Error stack';
            mockTwitchBot.quoteManager.addQuote.mockRejectedValue(saveError);

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                '@testuser Sorry, there was an error saving your quote. Your points have been refunded.'
            );
        });

        it('should handle duplicate quote error', async () => {
            const duplicateError = new Error('Duplicate entry');
            duplicateError.code = 'ER_DUP_ENTRY';
            mockTwitchBot.quoteManager.addQuote.mockRejectedValue(duplicateError);

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );
        });
    });

    describe('Status update error handling', () => {
        it('should handle error when updating status to FULFILLED', async () => {
            const statusError = new Error('API error');
            statusError.stack = 'Error stack';
            mockTwitchBot.redemptionManager.updateRedemptionStatus.mockRejectedValue(statusError);

            await expect(handleQuote(event, mockTwitchBot)).resolves.not.toThrow();
        });

        it('should not throw when refund fails', async () => {
            const saveError = new Error('Database error');
            const refundError = new Error('Refund API error');
            refundError.stack = 'Error stack';

            mockTwitchBot.quoteManager.addQuote.mockRejectedValue(saveError);
            mockTwitchBot.redemptionManager.updateRedemptionStatus.mockRejectedValue(refundError);

            await expect(handleQuote(event, mockTwitchBot)).resolves.not.toThrow();
        });
    });

    describe('Fatal error handling', () => {
        it('should attempt refund on fatal error', async () => {
            const fatalError = new Error('Fatal error');
            fatalError.stack = 'Error stack';
            mockTwitchBot.quoteManager.addQuote.mockRejectedValue(fatalError);

            await handleQuote(event, mockTwitchBot);

            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledWith(
                'broadcaster-456',
                'reward-789',
                ['redemption-abc'],
                'CANCELED'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'streamer',
                '@testuser Sorry, there was an error saving your quote. Your points have been refunded.'
            );
        });

        it('should not throw on any error', async () => {
            const unexpectedError = new Error('Unexpected error');
            unexpectedError.stack = 'Error stack';
            mockTwitchBot.quoteManager.addQuote.mockRejectedValue(unexpectedError);

            await expect(handleQuote(event, mockTwitchBot)).resolves.not.toThrow();
        });
    });

    describe('Integration scenarios', () => {
        it('should handle multiple quotes in sequence', async () => {
            const events = [
                { ...event, input: '"Quote 1" - Author 1' },
                { ...event, input: '"Quote 2" - Author 2' },
                { ...event, input: '"Quote 3" - Author 3' }
            ];

            mockTwitchBot.quoteManager.addQuote
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(2)
                .mockResolvedValueOnce(3);

            for (const evt of events) {
                await handleQuote(evt, mockTwitchBot);
            }

            expect(mockTwitchBot.quoteManager.addQuote).toHaveBeenCalledTimes(3);
            expect(mockTwitchBot.sendMessage).toHaveBeenCalledTimes(3);
        });

        it('should handle mix of valid and invalid quotes', async () => {
            const events = [
                { ...event, input: '"Valid quote" - Author' },
                { ...event, input: 'Invalid format' },
                { ...event, input: '"Another valid" - Author' }
            ];

            mockTwitchBot.quoteManager.addQuote
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(2);

            for (const evt of events) {
                await handleQuote(evt, mockTwitchBot);
            }

            expect(mockTwitchBot.quoteManager.addQuote).toHaveBeenCalledTimes(2);
            expect(mockTwitchBot.redemptionManager.updateRedemptionStatus).toHaveBeenCalledTimes(3);
        });
    });
});
