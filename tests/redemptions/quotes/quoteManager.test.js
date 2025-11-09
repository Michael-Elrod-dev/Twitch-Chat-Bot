// tests/redemptions/quotes/quoteManager.test.js

const QuoteManager = require('../../../src/redemptions/quotes/quoteManager');

describe('QuoteManager', () => {
    let quoteManager;
    let mockDbManager;

    beforeEach(() => {
        mockDbManager = {
            query: jest.fn()
        };

        quoteManager = new QuoteManager();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('init', () => {
        it('should initialize with database manager', async () => {
            await quoteManager.init(mockDbManager);

            expect(quoteManager.dbManager).toBe(mockDbManager);
        });

        it('should allow re-initialization', async () => {
            await quoteManager.init(mockDbManager);
            const newDbManager = { query: jest.fn() };
            await quoteManager.init(newDbManager);

            expect(quoteManager.dbManager).toBe(newDbManager);
        });
    });

    describe('addQuote', () => {
        beforeEach(async () => {
            await quoteManager.init(mockDbManager);
        });

        it('should insert quote into database', async () => {
            mockDbManager.query.mockResolvedValueOnce({ insertId: 1 });

            const quoteData = {
                quote: 'This is a test quote',
                author: 'TestAuthor',
                savedBy: 'SaverUser',
                userId: 'user123'
            };

            const result = await quoteManager.addQuote(quoteData);

            expect(result).toBe(1);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                ['This is a test quote', 'TestAuthor', 'SaverUser', 'user123']
            );
        });

        it('should return insertId after adding quote', async () => {
            mockDbManager.query.mockResolvedValueOnce({ insertId: 42 });

            const quoteData = {
                quote: 'Another quote',
                author: 'Author',
                savedBy: 'Saver',
                userId: 'user456'
            };

            const insertId = await quoteManager.addQuote(quoteData);

            expect(insertId).toBe(42);
        });

        it('should handle database errors', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Insert Failed'));

            const quoteData = {
                quote: 'Test',
                author: 'Author',
                savedBy: 'Saver',
                userId: 'user123'
            };

            await expect(quoteManager.addQuote(quoteData)).rejects.toThrow('DB Insert Failed');
        });

        it('should pass all quote data fields correctly', async () => {
            mockDbManager.query.mockResolvedValueOnce({ insertId: 1 });

            const quoteData = {
                quote: 'Multi word quote here',
                author: 'Famous Person',
                savedBy: 'ChatModerator',
                userId: 'mod123'
            };

            await quoteManager.addQuote(quoteData);

            const callArgs = mockDbManager.query.mock.calls[0][1];
            expect(callArgs[0]).toBe('Multi word quote here');
            expect(callArgs[1]).toBe('Famous Person');
            expect(callArgs[2]).toBe('ChatModerator');
            expect(callArgs[3]).toBe('mod123');
        });
    });

    describe('getQuoteById', () => {
        beforeEach(async () => {
            await quoteManager.init(mockDbManager);
        });

        it('should retrieve quote by ID', async () => {
            const mockQuote = {
                id: 1,
                quote: 'Test quote',
                author: 'Author',
                savedBy: 'Saver',
                savedAt: new Date('2024-01-01'),
                userId: 'user123'
            };

            mockDbManager.query.mockResolvedValueOnce([mockQuote]);

            const result = await quoteManager.getQuoteById(1);

            expect(result).toEqual(mockQuote);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                [1]
            );
        });

        it('should return null when quote not found', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            const result = await quoteManager.getQuoteById(999);

            expect(result).toBeNull();
        });

        it('should handle database errors gracefully', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            const result = await quoteManager.getQuoteById(1);

            expect(result).toBeNull();
        });

        it('should return first result when multiple rows returned', async () => {
            const mockQuotes = [
                { id: 1, quote: 'First', author: 'A', savedBy: 'S', savedAt: new Date(), userId: 'u1' },
                { id: 1, quote: 'Second', author: 'B', savedBy: 'S', savedAt: new Date(), userId: 'u2' }
            ];

            mockDbManager.query.mockResolvedValueOnce(mockQuotes);

            const result = await quoteManager.getQuoteById(1);

            expect(result).toEqual(mockQuotes[0]);
        });

        it('should pass correct ID parameter', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await quoteManager.getQuoteById(42);

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                [42]
            );
        });
    });

    describe('getRandomQuote', () => {
        beforeEach(async () => {
            await quoteManager.init(mockDbManager);
        });

        it('should retrieve a random quote', async () => {
            const mockQuote = {
                id: 5,
                quote: 'Random quote',
                author: 'Author',
                savedBy: 'Saver',
                savedAt: new Date('2024-01-01'),
                userId: 'user123'
            };

            mockDbManager.query.mockResolvedValueOnce([mockQuote]);

            const result = await quoteManager.getRandomQuote();

            expect(result).toEqual(mockQuote);
            expect(mockDbManager.query).toHaveBeenCalledWith(expect.any(String));
        });

        it('should return null when no quotes exist', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            const result = await quoteManager.getRandomQuote();

            expect(result).toBeNull();
        });

        it('should handle database errors gracefully', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            const result = await quoteManager.getRandomQuote();

            expect(result).toBeNull();
        });

        it('should return first result from random query', async () => {
            const mockQuote = {
                id: 3,
                quote: 'First of random results',
                author: 'Author',
                savedBy: 'Saver',
                savedAt: new Date(),
                userId: 'user123'
            };

            mockDbManager.query.mockResolvedValueOnce([mockQuote]);

            const result = await quoteManager.getRandomQuote();

            expect(result.id).toBe(3);
            expect(result.quote).toBe('First of random results');
        });
    });

    describe('getTotalQuotes', () => {
        beforeEach(async () => {
            await quoteManager.init(mockDbManager);
        });

        it('should return total count of quotes', async () => {
            mockDbManager.query.mockResolvedValueOnce([{ count: 42 }]);

            const result = await quoteManager.getTotalQuotes();

            expect(result).toBe(42);
            expect(mockDbManager.query).toHaveBeenCalledWith(expect.any(String));
        });

        it('should return 0 when no quotes exist', async () => {
            mockDbManager.query.mockResolvedValueOnce([{ count: 0 }]);

            const result = await quoteManager.getTotalQuotes();

            expect(result).toBe(0);
        });

        it('should return 0 on database error', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            const result = await quoteManager.getTotalQuotes();

            expect(result).toBe(0);
        });

        it('should handle large quote counts', async () => {
            mockDbManager.query.mockResolvedValueOnce([{ count: 999999 }]);

            const result = await quoteManager.getTotalQuotes();

            expect(result).toBe(999999);
        });

        it('should extract count from first row', async () => {
            mockDbManager.query.mockResolvedValueOnce([{ count: 100 }]);

            const result = await quoteManager.getTotalQuotes();

            expect(result).toBe(100);
        });
    });

    describe('Integration Scenarios', () => {
        beforeEach(async () => {
            await quoteManager.init(mockDbManager);
        });

        it('should handle complete quote lifecycle', async () => {
            // Add a quote
            mockDbManager.query.mockResolvedValueOnce({ insertId: 1 });
            const insertId = await quoteManager.addQuote({
                quote: 'Test quote',
                author: 'Author',
                savedBy: 'Saver',
                userId: 'user123'
            });
            expect(insertId).toBe(1);

            // Get it by ID
            mockDbManager.query.mockResolvedValueOnce([{
                id: 1,
                quote: 'Test quote',
                author: 'Author',
                savedBy: 'Saver',
                savedAt: new Date(),
                userId: 'user123'
            }]);
            const quote = await quoteManager.getQuoteById(1);
            expect(quote.quote).toBe('Test quote');

            // Check total count
            mockDbManager.query.mockResolvedValueOnce([{ count: 1 }]);
            const total = await quoteManager.getTotalQuotes();
            expect(total).toBe(1);
        });

        it('should handle empty database state', async () => {
            mockDbManager.query.mockResolvedValueOnce([{ count: 0 }]);
            const total = await quoteManager.getTotalQuotes();
            expect(total).toBe(0);

            mockDbManager.query.mockResolvedValueOnce([]);
            const randomQuote = await quoteManager.getRandomQuote();
            expect(randomQuote).toBeNull();

            mockDbManager.query.mockResolvedValueOnce([]);
            const specificQuote = await quoteManager.getQuoteById(1);
            expect(specificQuote).toBeNull();
        });

        it('should handle multiple quotes correctly', async () => {
            // Add first quote
            mockDbManager.query.mockResolvedValueOnce({ insertId: 1 });
            await quoteManager.addQuote({
                quote: 'First',
                author: 'A1',
                savedBy: 'S1',
                userId: 'u1'
            });

            // Add second quote
            mockDbManager.query.mockResolvedValueOnce({ insertId: 2 });
            await quoteManager.addQuote({
                quote: 'Second',
                author: 'A2',
                savedBy: 'S2',
                userId: 'u2'
            });

            // Get total
            mockDbManager.query.mockResolvedValueOnce([{ count: 2 }]);
            const total = await quoteManager.getTotalQuotes();
            expect(total).toBe(2);
        });
    });

    describe('Error Handling', () => {
        beforeEach(async () => {
            await quoteManager.init(mockDbManager);
        });

        it('should handle connection errors in addQuote', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('Connection lost'));

            await expect(quoteManager.addQuote({
                quote: 'Test',
                author: 'A',
                savedBy: 'S',
                userId: 'u'
            })).rejects.toThrow('Connection lost');
        });

        it('should not throw in getQuoteById on error', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('Query failed'));

            const result = await quoteManager.getQuoteById(1);

            expect(result).toBeNull();
        });

        it('should not throw in getRandomQuote on error', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('Query failed'));

            const result = await quoteManager.getRandomQuote();

            expect(result).toBeNull();
        });

        it('should not throw in getTotalQuotes on error', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('Query failed'));

            const result = await quoteManager.getTotalQuotes();

            expect(result).toBe(0);
        });
    });
});
