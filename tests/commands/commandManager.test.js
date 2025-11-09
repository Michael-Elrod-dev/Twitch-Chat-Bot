// tests/commands/commandManager.test.js

const CommandManager = require('../../src/commands/commandManager');

// Mock config
jest.mock('../../src/config/config', () => ({
    commandCacheInterval: 60000
}));

describe('CommandManager', () => {
    let commandManager;
    let mockDbManager;
    let mockSpecialHandlers;
    let mockTwitchBot;

    beforeEach(() => {
        mockDbManager = {
            query: jest.fn()
        };

        mockSpecialHandlers = {
            handleQuote: jest.fn(),
            handleStats: jest.fn()
        };

        commandManager = new CommandManager(mockSpecialHandlers);

        // Mock Twitch bot
        mockTwitchBot = {
            sendMessage: jest.fn().mockResolvedValue(undefined),
            twitchAPI: {
                getCustomRewards: jest.fn(),
                updateCustomReward: jest.fn(),
                getStreamByUserName: jest.fn()
            },
            viewerManager: {},
            analyticsManager: {},
            emoteManager: {}
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('init and loadCommands', () => {
        it('should load commands from database', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { command_name: '!test', response_text: 'Test response', handler_name: null, user_level: 'everyone' },
                { command_name: '!mod', response_text: 'Mod only', handler_name: null, user_level: 'mod' }
            ]);

            await commandManager.init(mockDbManager);

            expect(mockDbManager.query).toHaveBeenCalledWith(expect.any(String));
            expect(commandManager.commandCache.size).toBe(2);
        });

        it('should normalize command names to lowercase', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { command_name: '!TEST', response_text: 'Response', handler_name: null, user_level: 'everyone' }
            ]);

            await commandManager.init(mockDbManager);

            expect(commandManager.commandCache.has('!test')).toBe(true);
        });

        it('should store handler information', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { command_name: '!quote', response_text: null, handler_name: 'handleQuote', user_level: 'everyone' }
            ]);

            await commandManager.init(mockDbManager);

            const command = commandManager.commandCache.get('!quote');
            expect(command.handler).toBe('handleQuote');
        });

        it('should set cache expiry time', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await commandManager.init(mockDbManager);

            expect(commandManager.cacheExpiry).toBeGreaterThan(Date.now());
        });

        it('should handle database errors during init', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Connection Failed'));

            await expect(commandManager.init(mockDbManager)).rejects.toThrow('DB Connection Failed');
        });
    });

    describe('getCommand', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { command_name: '!test', response_text: 'Response', handler_name: null, user_level: 'everyone' }
            ]);
            await commandManager.init(mockDbManager);
        });

        it('should retrieve command from cache', async () => {
            const command = await commandManager.getCommand('!test');

            expect(command).toEqual({
                response: 'Response',
                handler: null,
                userLevel: 'everyone'
            });
        });

        it('should be case insensitive', async () => {
            const command = await commandManager.getCommand('!TEST');

            expect(command).toBeDefined();
        });

        it('should return null for non-existent command', async () => {
            const command = await commandManager.getCommand('!nonexistent');

            expect(command).toBeNull();
        });

        it('should refresh cache when expired', async () => {
            // Expire cache
            commandManager.cacheExpiry = Date.now() - 1000;

            mockDbManager.query.mockResolvedValueOnce([
                { command_name: '!new', response_text: 'New', handler_name: null, user_level: 'everyone' }
            ]);

            await commandManager.getCommand('!new');

            // Should have called query twice (init + refresh)
            expect(mockDbManager.query).toHaveBeenCalledTimes(2);
        });
    });

    describe('addCommand', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([]);
            await commandManager.init(mockDbManager);
        });

        it('should insert new command into database', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            const result = await commandManager.addCommand('!new', 'New response');

            expect(result).toBe(true);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                ['!new', 'New response', 'everyone']
            );
        });

        it('should add command to cache', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await commandManager.addCommand('!cached', 'Cached response');

            expect(commandManager.commandCache.has('!cached')).toBe(true);
            expect(commandManager.commandCache.get('!cached')).toEqual({
                response: 'Cached response',
                handler: null,
                userLevel: 'everyone'
            });
        });

        it('should handle duplicate command error', async () => {
            mockDbManager.query.mockRejectedValueOnce({ code: 'ER_DUP_ENTRY' });

            const result = await commandManager.addCommand('!duplicate', 'Response');

            expect(result).toBe(false);
        });

        it('should lowercase command name', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await commandManager.addCommand('!UPPER', 'Response');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.anything(),
                expect.arrayContaining(['!upper'])
            );
        });

        it('should respect custom user level', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);

            await commandManager.addCommand('!mod', 'Mod only', 'mod');

            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.anything(),
                ['!mod', 'Mod only', 'mod']
            );
        });
    });

    describe('editCommand', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { command_name: '!edit', response_text: 'Old', handler_name: null, user_level: 'everyone' },
                { command_name: '!special', response_text: null, handler_name: 'handleSpecial', user_level: 'everyone' }
            ]);
            await commandManager.init(mockDbManager);
        });

        it('should update existing command', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });

            const result = await commandManager.editCommand('!edit', 'New response');

            expect(result).toBe(true);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.any(String),
                ['New response', '!edit']
            );
        });

        it('should update cache after edit', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });

            await commandManager.editCommand('!edit', 'Updated');

            const command = commandManager.commandCache.get('!edit');
            expect(command.response).toBe('Updated');
        });

        it('should not edit command with handler', async () => {
            const result = await commandManager.editCommand('!special', 'Attempt');

            expect(result).toBe(false);
            expect(mockDbManager.query).toHaveBeenCalledTimes(1); // Only init call
        });

        it('should not edit non-existent command', async () => {
            const result = await commandManager.editCommand('!nonexistent', 'Test');

            expect(result).toBe(false);
        });

        it('should handle database errors', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            await expect(
                commandManager.editCommand('!edit', 'New')
            ).rejects.toThrow('DB Error');
        });
    });

    describe('deleteCommand', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { command_name: '!delete', response_text: 'Will delete', handler_name: null, user_level: 'everyone' },
                { command_name: '!special', response_text: null, handler_name: 'handler', user_level: 'everyone' }
            ]);
            await commandManager.init(mockDbManager);
        });

        it('should delete command from database', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });

            const result = await commandManager.deleteCommand('!delete');

            expect(result).toBe(true);
            expect(mockDbManager.query).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM commands'),
                ['!delete']
            );
        });

        it('should remove command from cache', async () => {
            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });

            await commandManager.deleteCommand('!delete');

            expect(commandManager.commandCache.has('!delete')).toBe(false);
        });

        it('should not delete command with handler', async () => {
            const result = await commandManager.deleteCommand('!special');

            expect(result).toBe(false);
        });

        it('should not delete non-existent command', async () => {
            const result = await commandManager.deleteCommand('!nonexistent');

            expect(result).toBe(false);
        });
    });

    describe('handleCommand - !command meta-command', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([]);
            await commandManager.init(mockDbManager);
        });

        it('should show usage when called without arguments', async () => {
            const context = { mod: true };

            await commandManager.handleCommand(mockTwitchBot, 'channel', context, '!command');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                expect.stringContaining('Usage:')
            );
        });

        it('should require mod or broadcaster permission', async () => {
            const context = { mod: false, badges: {} };

            await commandManager.handleCommand(mockTwitchBot, 'channel', context, '!command add !test');

            // Should return early, not send any message
            expect(mockTwitchBot.sendMessage).not.toHaveBeenCalled();
        });

        it('should allow broadcaster to manage commands', async () => {
            const context = { mod: false, badges: { broadcaster: true } };
            mockDbManager.query.mockResolvedValueOnce([]);

            await commandManager.handleCommand(
                mockTwitchBot,
                'channel',
                context,
                '!command add !test response'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                expect.stringContaining('added')
            );
        });

        it('should add new command', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);
            const context = { mod: true };

            await commandManager.handleCommand(
                mockTwitchBot,
                'channel',
                context,
                '!command add !hello Hello world!'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Command !hello has been added.'
            );
        });

        it('should reject command without ! prefix', async () => {
            const context = { mod: true };

            await commandManager.handleCommand(
                mockTwitchBot,
                'channel',
                context,
                '!command add hello response'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Command must start with !'
            );
        });

        it('should edit existing command', async () => {
            mockDbManager.query
                .mockResolvedValueOnce([
                    { command_name: '!edit', response_text: 'Old', handler_name: null, user_level: 'everyone' }
                ]);
            await commandManager.init(mockDbManager);

            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });
            const context = { mod: true };

            await commandManager.handleCommand(
                mockTwitchBot,
                'channel',
                context,
                '!command edit !edit New response'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Command !edit has been updated.'
            );
        });

        it('should delete command', async () => {
            mockDbManager.query
                .mockResolvedValueOnce([
                    { command_name: '!delete', response_text: 'Text', handler_name: null, user_level: 'everyone' }
                ]);
            await commandManager.init(mockDbManager);

            mockDbManager.query.mockResolvedValueOnce({ affectedRows: 1 });
            const context = { mod: true };

            await commandManager.handleCommand(
                mockTwitchBot,
                'channel',
                context,
                '!command delete !delete'
            );

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Command !delete has been deleted.'
            );
        });

        it('should handle multi-word responses', async () => {
            mockDbManager.query.mockResolvedValueOnce([]);
            const context = { mod: true };

            await commandManager.handleCommand(
                mockTwitchBot,
                'channel',
                context,
                '!command add !multiword This is a long response with many words'
            );

            // Should join all words after command name
            expect(commandManager.commandCache.get('!multiword').response).toBe(
                'This is a long response with many words'
            );
        });
    });

    describe('handleCommand - regular commands', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { command_name: '!test', response_text: 'Test response', handler_name: null, user_level: 'everyone' },
                { command_name: '!mod', response_text: 'Mod only', handler_name: null, user_level: 'mod' },
                { command_name: '!broadcaster', response_text: 'BC only', handler_name: null, user_level: 'broadcaster' },
                { command_name: '!quote', response_text: null, handler_name: 'handleQuote', user_level: 'everyone' }
            ]);
            await commandManager.init(mockDbManager);
        });

        it('should execute simple text command', async () => {
            const context = { mod: false, badges: {} };

            await commandManager.handleCommand(mockTwitchBot, 'channel', context, '!test');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Test response'
            );
        });

        it('should enforce mod permission', async () => {
            const context = { mod: false, badges: {} };

            await commandManager.handleCommand(mockTwitchBot, 'channel', context, '!mod');

            // Should return early, not send message
            expect(mockTwitchBot.sendMessage).not.toHaveBeenCalled();
        });

        it('should allow mod to use mod command', async () => {
            const context = { mod: true };

            await commandManager.handleCommand(mockTwitchBot, 'channel', context, '!mod');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Mod only'
            );
        });

        it('should enforce broadcaster permission', async () => {
            const context = { mod: true, badges: {} };

            await commandManager.handleCommand(mockTwitchBot, 'channel', context, '!broadcaster');

            expect(mockTwitchBot.sendMessage).not.toHaveBeenCalled();
        });

        it('should allow broadcaster to use broadcaster command', async () => {
            const context = { badges: { broadcaster: true } };

            await commandManager.handleCommand(mockTwitchBot, 'channel', context, '!broadcaster');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'BC only'
            );
        });

        it('should execute special handler command', async () => {
            const context = { mod: false };
            mockSpecialHandlers.handleQuote.mockResolvedValueOnce(undefined);

            await commandManager.handleCommand(mockTwitchBot, 'channel', context, '!quote 5');

            expect(mockSpecialHandlers.handleQuote).toHaveBeenCalled();
        });

        it('should pass arguments to handler', async () => {
            const context = { mod: false };
            mockSpecialHandlers.handleQuote.mockResolvedValueOnce(undefined);

            await commandManager.handleCommand(mockTwitchBot, 'channel', context, '!quote arg1 arg2');

            const callArgs = mockSpecialHandlers.handleQuote.mock.calls[0];
            expect(callArgs[3]).toEqual(['arg1', 'arg2']); // args parameter
        });

        it('should ignore non-existent commands', async () => {
            const context = {};

            await commandManager.handleCommand(mockTwitchBot, 'channel', context, '!nonexistent');

            expect(mockTwitchBot.sendMessage).not.toHaveBeenCalled();
        });

        it('should be case insensitive', async () => {
            const context = {};

            await commandManager.handleCommand(mockTwitchBot, 'channel', context, '!TEST');

            expect(mockTwitchBot.sendMessage).toHaveBeenCalledWith(
                'channel',
                'Test response'
            );
        });
    });

    describe('getAllCommands', () => {
        beforeEach(async () => {
            mockDbManager.query.mockResolvedValueOnce([]);
            await commandManager.init(mockDbManager);
        });

        it('should fetch all commands from database', async () => {
            mockDbManager.query.mockResolvedValueOnce([
                { command_name: '!test', response_text: 'Response', handler_name: null, user_level: 'everyone', created_at: new Date(), updated_at: new Date() }
            ]);

            const commands = await commandManager.getAllCommands();

            expect(mockDbManager.query).toHaveBeenCalledWith(expect.any(String));
            expect(commands).toHaveLength(1);
        });

        it('should return empty array on error', async () => {
            mockDbManager.query.mockRejectedValueOnce(new Error('DB Error'));

            const commands = await commandManager.getAllCommands();

            expect(commands).toEqual([]);
        });
    });
});
