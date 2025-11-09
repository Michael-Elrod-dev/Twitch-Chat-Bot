// tests/emotes/emoteManager.test.js

const EmoteManager = require('../../src/emotes/emoteManager');

// Mock logger
jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

// Mock config
jest.mock('../../src/config/config', () => ({
    emoteCacheInterval: 60000
}));

describe('EmoteManager', () => {
    let emoteManager;
    let mockDbManager;

    beforeEach(() => {
        mockDbManager = {
            query: jest.fn()
        };

        emoteManager = new EmoteManager();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('init and loadEmotes', () => {
        it('should load emotes from database', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { trigger_text: 'KEKW', response_text: 'LUL' },
                { trigger_text: 'PogChamp', response_text: 'PauseChamp' }
            ]);

            await emoteManager.init(mockDbManager);

            expect(mockDbManager.query).toHaveBeenCalledWith(expect.any(String));
            expect(emoteManager.emoteCache.size).toBe(2);
        });

        it('should normalize trigger text to lowercase', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { trigger_text: 'KEKW', response_text: 'LUL' }
            ]);

            await emoteManager.init(mockDbManager);

            expect(emoteManager.emoteCache.has('kekw')).toBe(true);
        });

        it('should set cache expiry time', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await emoteManager.init(mockDbManager);

            expect(emoteManager.cacheExpiry).toBeGreaterThan(Date.now());
        });

        it('should handle database errors during init', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Connection Failed'));

            await expect(emoteManager.init(mockDbManager)).rejects.toThrow('DB Connection Failed');
        });

        it('should clear cache before reloading', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { trigger_text: 'test', response_text: 'response' }
            ]);
            await emoteManager.init(mockDbManager);

            mockDbManager.query.mockResolvedValueOnce([
                { trigger_text: 'new', response_text: 'new response' }
            ]);
            await emoteManager.loadEmotes();

            expect(emoteManager.emoteCache.has('test')).toBe(false);
            expect(emoteManager.emoteCache.has('new')).toBe(true);
        });
    });

    describe('getEmoteResponse', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { trigger_text: 'KEKW', response_text: 'LUL' }
            ]);
            await emoteManager.init(mockDbManager);
        });

        it('should retrieve emote from cache', async () => {
            const response = await emoteManager.getEmoteResponse('KEKW');

            expect(response).toBe('LUL');
        });

        it('should be case insensitive', async () => {
            const response = await emoteManager.getEmoteResponse('kekw');

            expect(response).toBeDefined();
            expect(response).toBe('LUL');
        });

        it('should return null for non-existent emote', async () => {
            const response = await emoteManager.getEmoteResponse('nonexistent');

            expect(response).toBeNull();
        });

        it('should refresh cache when expired', async () => {
            // Expire cache
            emoteManager.cacheExpiry = Date.now() - 1000;

            mockDbManager.query.mockResolvedValueOnce([
                { trigger_text: 'new', response_text: 'New Response' }
            ]);

            await emoteManager.getEmoteResponse('new');

            // Should have called query twice (init + refresh)
            expect(mockDbManager.query).toHaveBeenCalledTimes(2);
        });

        it('should return null on error', async () => {
            // Force an error by expiring cache and making query fail
            emoteManager.cacheExpiry = Date.now() - 1000;
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            const response = await emoteManager.getEmoteResponse('test');

            expect(response).toBeNull();
        });
    });

    describe('addEmote', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([]);
            await emoteManager.init(mockDbManager);
        });

        it('should insert new emote into database', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            const result = await emoteManager.addEmote('PogChamp', 'PauseChamp');

            expect(result).toBe(true);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                ['pogchamp', 'PauseChamp']
            );
        });

        it('should add emote to cache', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await emoteManager.addEmote('Clap', 'PogChamp');

            expect(emoteManager.emoteCache.has('clap')).toBe(true);
            expect(emoteManager.emoteCache.get('clap')).toBe('PogChamp');
        });

        it('should handle duplicate emote error', async () => {
            mockDbManager.query.mockRejectedValueOnce({ code: 'ER_DUP_ENTRY' });

            const result = await emoteManager.addEmote('duplicate', 'Response');

            expect(result).toBe(false);
        });

        it('should lowercase trigger text', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await emoteManager.addEmote('UPPER', 'Response');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.anything(),
                expect.arrayContaining(['upper'])
            );
        });

        it('should throw on non-duplicate errors', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('Some other error'));

            await expect(
                emoteManager.addEmote('test', 'response')
            ).rejects.toThrow('Some other error');
        });
    });

    describe('updateEmote', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { trigger_text: 'edit', response_text: 'Old Response' }
            ]);
            await emoteManager.init(mockDbManager);
        });

        it('should update existing emote', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });

            const result = await emoteManager.updateEmote('edit', 'New Response');

            expect(result).toBe(true);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                ['New Response', 'edit']
            );
        });

        it('should update cache after edit', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });

            await emoteManager.updateEmote('edit', 'Updated');

            expect(emoteManager.emoteCache.get('edit')).toBe('Updated');
        });

        it('should return false for non-existent emote', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 0 });

            const result = await emoteManager.updateEmote('nonexistent', 'Test');

            expect(result).toBe(false);
        });

        it('should handle database errors', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            await expect(
                emoteManager.updateEmote('edit', 'New')
            ).rejects.toThrow('DB Error');
        });

        it('should lowercase trigger text', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });

            await emoteManager.updateEmote('EDIT', 'Response');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.anything(),
                expect.arrayContaining(['edit'])
            );
        });

        it('should not update cache if no rows affected', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 0 });

            await emoteManager.updateEmote('edit', 'NewValue');

            // Cache should still have old value
            expect(emoteManager.emoteCache.get('edit')).toBe('Old Response');
        });
    });

    describe('deleteEmote', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { trigger_text: 'delete', response_text: 'Will delete' }
            ]);
            await emoteManager.init(mockDbManager);
        });

        it('should delete emote from database', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });

            const result = await emoteManager.deleteEmote('delete');

            expect(result).toBe(true);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                ['delete']
            );
        });

        it('should remove emote from cache', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });

            await emoteManager.deleteEmote('delete');

            expect(emoteManager.emoteCache.has('delete')).toBe(false);
        });

        it('should return false for non-existent emote', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 0 });

            const result = await emoteManager.deleteEmote('nonexistent');

            expect(result).toBe(false);
        });

        it('should handle database errors', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            await expect(
                emoteManager.deleteEmote('delete')
            ).rejects.toThrow('DB Error');
        });

        it('should lowercase trigger text', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });

            await emoteManager.deleteEmote('DELETE');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.anything(),
                expect.arrayContaining(['delete'])
            );
        });

        it('should not remove from cache if no rows affected', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 0 });

            await emoteManager.deleteEmote('delete');

            // Should still be in cache
            expect(emoteManager.emoteCache.has('delete')).toBe(true);
        });
    });

    describe('getAllEmotes', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([]);
            await emoteManager.init(mockDbManager);
        });

        it('should fetch all emotes from database', async () => {
            const mockDate = new Date();
            mockDbManager.query.mockResolvedValueOnce([
                { trigger_text: 'test', response_text: 'Response', created_at: mockDate, updated_at: mockDate }
            ]);

            const emotes = await emoteManager.getAllEmotes();

            expect(mockDbManager.query).toHaveBeenCalledWith(expect.any(String));
            expect(emotes).toHaveLength(1);
        });

        it('should return empty array on error', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            const emotes = await emoteManager.getAllEmotes();

            expect(emotes).toEqual([]);
        });

        it('should return emotes in order', async () => {
            const mockDate = new Date();
            mockDbManager.query.mockResolvedValueOnce([
                { trigger_text: 'a', response_text: 'First', created_at: mockDate, updated_at: mockDate },
                { trigger_text: 'b', response_text: 'Second', created_at: mockDate, updated_at: mockDate }
            ]);

            const emotes = await emoteManager.getAllEmotes();

            expect(emotes[0].trigger_text).toBe('a');
            expect(emotes[1].trigger_text).toBe('b');
        });
    });

    describe('Cache Management', () => {
        it('should store multiple emotes in cache', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { trigger_text: 'KEKW', response_text: 'LUL' },
                { trigger_text: 'PogChamp', response_text: 'PauseChamp' },
                { trigger_text: 'Clap', response_text: 'PogChamp' }
            ]);

            await emoteManager.init(mockDbManager);

            expect(emoteManager.emoteCache.size).toBe(3);
            expect(emoteManager.emoteCache.get('kekw')).toBe('LUL');
            expect(emoteManager.emoteCache.get('pogchamp')).toBe('PauseChamp');
            expect(emoteManager.emoteCache.get('clap')).toBe('PogChamp');
        });

        it('should use cache timeout from config', () => {
            expect(emoteManager.cacheTimeout).toBe(60000);
        });
    });
});
