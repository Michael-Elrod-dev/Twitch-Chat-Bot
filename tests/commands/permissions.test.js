/**
 * P1-9: permission is decided in exactly one place.
 */

describe('P1-9: permission enforced in exactly one place', () => {
    const CommandManager = require('../../src/commands/commandManager');

    const viewer = { username: 'viewer', mod: false, badges: {} };
    const mod = { username: 'mod', mod: true, badges: {} };
    const broadcaster = { username: 'bc', mod: false, badges: { broadcaster: true } };

    describe('hasPermission', () => {
        it('should let anyone run an everyone command', () => {
            expect(CommandManager.hasPermission('everyone', viewer)).toBe(true);
        });

        it('should gate mod commands', () => {
            expect(CommandManager.hasPermission('mod', viewer)).toBe(false);
            expect(CommandManager.hasPermission('mod', mod)).toBe(true);
            expect(CommandManager.hasPermission('mod', broadcaster)).toBe(true);
        });

        it('should gate broadcaster commands against mods too', () => {
            expect(CommandManager.hasPermission('broadcaster', mod)).toBe(false);
            expect(CommandManager.hasPermission('broadcaster', broadcaster)).toBe(true);
        });

        it('should treat an unknown level as everyone', () => {
            expect(CommandManager.hasPermission('wizard', viewer)).toBe(true);
        });
    });

    describe('enforcement', () => {
        let manager;
        let twitchBot;
        let skipSong;

        beforeEach(async () => {
            skipSong = jest.fn().mockResolvedValue(undefined);
            manager = new CommandManager({ skipSong }, { skipSong: 'mod' });
            manager.dbManager = { query: jest.fn().mockResolvedValue([]) };
            manager.commandCache.set('!skip', {
                response: null,
                handler: 'skipSong',
                userLevel: 'everyone'
            });
            manager.cacheExpiry = Date.now() + 60000;

            twitchBot = { sendMessage: jest.fn().mockResolvedValue(undefined) };
        });

        it('should block a viewer from a handler that declares mod', async () => {
            // The DB row says 'everyone'; the declaration says 'mod' and wins.
            await manager.handleCommand(twitchBot, 'chan', viewer, '!skip');

            expect(skipSong).not.toHaveBeenCalled();
        });

        it('should allow a mod', async () => {
            await manager.handleCommand(twitchBot, 'chan', mod, '!skip');

            expect(skipSong).toHaveBeenCalled();
        });

        it('should prefer the declared level over the DB row', () => {
            expect(manager.resolveUserLevel({ handler: 'skipSong', userLevel: 'everyone' }))
                .toBe('mod');
        });

        it('should fall back to the DB level for static commands', () => {
            expect(manager.resolveUserLevel({ handler: null, userLevel: 'broadcaster' }))
                .toBe('broadcaster');
        });
    });

    describe('DB reconciliation at load', () => {
        it('should correct a stale user_level for a handler command', async () => {
            const manager = new CommandManager({ skipSong: jest.fn() }, { skipSong: 'mod' });
            manager.dbManager = {
                query: jest.fn().mockResolvedValue([
                    { command_name: '!skip', response_text: null, handler_name: 'skipSong', user_level: 'everyone' }
                ])
            };

            await manager.loadCommands();

            expect(manager.dbManager.query).toHaveBeenCalledWith(
                'UPDATE commands SET user_level = ? WHERE command_name = ?',
                ['mod', '!skip']
            );
            expect(manager.commandCache.get('!skip').userLevel).toBe('mod');
        });

        it('should leave an already-correct row alone', async () => {
            const manager = new CommandManager({ skipSong: jest.fn() }, { skipSong: 'mod' });
            manager.dbManager = {
                query: jest.fn().mockResolvedValue([
                    { command_name: '!skip', response_text: null, handler_name: 'skipSong', user_level: 'mod' }
                ])
            };

            await manager.loadCommands();

            const updates = manager.dbManager.query.mock.calls
                .filter(([sql]) => sql.includes('UPDATE commands'));
            expect(updates).toHaveLength(0);
        });

        it('should not touch static commands', async () => {
            const manager = new CommandManager({}, {});
            manager.dbManager = {
                query: jest.fn().mockResolvedValue([
                    { command_name: '!discord', response_text: 'link', handler_name: null, user_level: 'everyone' }
                ])
            };

            await manager.loadCommands();

            const updates = manager.dbManager.query.mock.calls
                .filter(([sql]) => sql.includes('UPDATE commands'));
            expect(updates).toHaveLength(0);
        });
    });
});

describe('WP-7.1: the vip tier', () => {
    const CommandManager = require('../../src/commands/commandManager');

    const viewer = { username: 'viewer', mod: false, vip: false, badges: {} };
    const vip = { username: 'vip', mod: false, vip: true, badges: {} };
    const mod = { username: 'mod', mod: true, vip: false, badges: {} };
    const broadcaster = { username: 'bc', mod: false, vip: false, badges: { broadcaster: true } };

    describe('ordering: everyone < vip < mod < broadcaster', () => {
        it('should let everyone run an everyone command', () => {
            [viewer, vip, mod, broadcaster].forEach(ctx =>
                expect(CommandManager.hasPermission('everyone', ctx)).toBe(true));
        });

        it('should let vip and above run a vip command', () => {
            expect(CommandManager.hasPermission('vip', vip)).toBe(true);
            expect(CommandManager.hasPermission('vip', mod)).toBe(true);
            expect(CommandManager.hasPermission('vip', broadcaster)).toBe(true);
        });

        it('should block a plain viewer from a vip command', () => {
            expect(CommandManager.hasPermission('vip', viewer)).toBe(false);
        });

        it('should NOT let a vip run a mod command', () => {
            expect(CommandManager.hasPermission('mod', vip)).toBe(false);
        });

        it('should NOT let a vip run a broadcaster command', () => {
            expect(CommandManager.hasPermission('broadcaster', vip)).toBe(false);
        });

        it('should rank a vip who is also a mod as a mod', () => {
            const both = { mod: true, vip: true, badges: {} };

            expect(CommandManager.rankOf(both)).toBe(CommandManager.rankOf(mod));
            expect(CommandManager.hasPermission('mod', both)).toBe(true);
        });

        it('should rank the broadcaster highest regardless of other flags', () => {
            const bcVip = { mod: false, vip: true, badges: { broadcaster: true } };

            expect(CommandManager.hasPermission('broadcaster', bcVip)).toBe(true);
        });

        it('should treat a missing vip flag as not vip', () => {
            expect(CommandManager.hasPermission('vip', { mod: false, badges: {} })).toBe(false);
        });
    });

    describe('the trap case: a command row set to vip', () => {
        let manager;
        let handler;
        let twitchBot;

        beforeEach(() => {
            handler = jest.fn().mockResolvedValue(undefined);
            manager = new CommandManager({ someHandler: handler }, {});
            manager.dbManager = { query: jest.fn().mockResolvedValue([]) };
            // A static command whose DB row says 'vip'. Before WP-7.1 this level was
            // unrecognised and fell through to 'everyone' - MORE permissive, not less.
            manager.commandCache.set('!vipcmd', {
                response: 'vip only',
                handler: null,
                userLevel: 'vip'
            });
            manager.cacheExpiry = Date.now() + 60000;

            twitchBot = { sendMessage: jest.fn().mockResolvedValue(undefined) };
        });

        it('should block a plain viewer', async () => {
            await manager.handleCommand(twitchBot, 'chan', viewer, '!vipcmd');

            expect(twitchBot.sendMessage).not.toHaveBeenCalled();
        });

        it('should allow a vip', async () => {
            await manager.handleCommand(twitchBot, 'chan', vip, '!vipcmd');

            expect(twitchBot.sendMessage).toHaveBeenCalledWith('chan', 'vip only');
        });

        it('should allow a mod', async () => {
            await manager.handleCommand(twitchBot, 'chan', mod, '!vipcmd');

            expect(twitchBot.sendMessage).toHaveBeenCalledWith('chan', 'vip only');
        });

        it('should allow the broadcaster', async () => {
            await manager.handleCommand(twitchBot, 'chan', broadcaster, '!vipcmd');

            expect(twitchBot.sendMessage).toHaveBeenCalledWith('chan', 'vip only');
        });

        it('should gate a vip-declaring handler the same way', async () => {
            manager.handlerLevels = { someHandler: 'vip' };
            manager.commandCache.set('!vippy', {
                response: null,
                handler: 'someHandler',
                userLevel: 'everyone'
            });

            await manager.handleCommand(twitchBot, 'chan', viewer, '!vippy');
            expect(handler).not.toHaveBeenCalled();

            await manager.handleCommand(twitchBot, 'chan', vip, '!vippy');
            expect(handler).toHaveBeenCalled();
        });
    });

    describe('existing tiers are unchanged', () => {
        it('should still gate mod commands exactly as before', () => {
            expect(CommandManager.hasPermission('mod', viewer)).toBe(false);
            expect(CommandManager.hasPermission('mod', mod)).toBe(true);
            expect(CommandManager.hasPermission('mod', broadcaster)).toBe(true);
        });

        it('should still gate broadcaster commands against mods', () => {
            expect(CommandManager.hasPermission('broadcaster', mod)).toBe(false);
            expect(CommandManager.hasPermission('broadcaster', broadcaster)).toBe(true);
        });

        it('should still treat an unknown level as unrestricted', () => {
            expect(CommandManager.hasPermission('wizard', viewer)).toBe(true);
        });
    });
});
