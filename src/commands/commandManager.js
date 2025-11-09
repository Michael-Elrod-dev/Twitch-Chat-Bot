// src/commands/commandManager.js

const config = require('../config/config');

class CommandManager {
    constructor(specialCommandHandlers) {
        this.specialCommandHandlers = specialCommandHandlers;
        this.dbManager = null;
        this.commandCache = new Map();
        this.cacheExpiry = null;
        this.cacheTimeout = config.commandCacheInterval;
    }

    async init(dbManager) {
        this.dbManager = dbManager;
        await this.loadCommands();
    }

    async loadCommands() {
        try {
            const sql = `
                SELECT command_name, response_text, handler_name, user_level
                FROM commands
            `;
            const results = await this.dbManager.query(sql);

            // Clear and rebuild cache
            this.commandCache.clear();
            for (const row of results) {
                this.commandCache.set(row.command_name.toLowerCase(), {
                    response: row.response_text,
                    handler: row.handler_name,
                    userLevel: row.user_level
                });
            }

            this.cacheExpiry = Date.now() + this.cacheTimeout;
            console.log(`✅ Loaded ${this.commandCache.size} commands`);
        } catch (error) {
            console.error('❌ Error loading commands:', error);
            throw error;
        }
    }

    async getCommand(commandName) {
        try {
            // Check if cache needs refresh
            if (Date.now() > this.cacheExpiry) {
                await this.loadCommands();
            }

            return this.commandCache.get(commandName.toLowerCase()) || null;
        } catch (error) {
            console.error('❌ Error getting command:', error);
            return null;
        }
    }

    async handleCommand(twitchBot, channel, context, message) {
        if (message === '!command' || message.startsWith('!command ')) {
            // Only allow mods and broadcaster to use this command
            if (!context.mod && !context.badges?.broadcaster) return;

            const args = message.split(' ');

            if (args.length === 1) {
                await this.sendChatMessage(twitchBot, channel, 'Usage: !command <add/edit/delete> !commandname [message]');
                return;
            }

            const action = args[1].toLowerCase();

            if (args.length < 3) {
                await this.sendChatMessage(twitchBot, channel, 'Usage: !command <add/edit/delete> !commandname [message]');
                return;
            }

            const commandName = args[2].toLowerCase();

            if (!commandName.startsWith('!')) {
                await this.sendChatMessage(twitchBot, channel, 'Command must start with !');
                return;
            }

            switch (action) {
            case 'add': {
                if (args.length < 4) {
                    await this.sendChatMessage(twitchBot, channel, 'Usage: !command add !commandname <message>');
                    return;
                }
                const response = args.slice(3).join(' ');
                if (await this.addCommand(commandName, response)) {
                    await this.sendChatMessage(twitchBot, channel, `Command ${commandName} has been added.`);
                } else {
                    await this.sendChatMessage(twitchBot, channel, `Command ${commandName} already exists.`);
                }
                break;
            }
            case 'edit': {
                if (args.length < 4) {
                    await this.sendChatMessage(twitchBot, channel, 'Usage: !command edit !commandname <new message>');
                    return;
                }
                const response = args.slice(3).join(' ');
                if (await this.editCommand(commandName, response)) {
                    await this.sendChatMessage(twitchBot, channel, `Command ${commandName} has been updated.`);
                } else {
                    await this.sendChatMessage(twitchBot, channel, `Cannot edit ${commandName} (command doesn't exist or has special handling).`);
                }
                break;
            }
            case 'delete': {
                if (await this.deleteCommand(commandName)) {
                    await this.sendChatMessage(twitchBot, channel, `Command ${commandName} has been deleted.`);
                } else {
                    await this.sendChatMessage(twitchBot, channel, `Cannot delete ${commandName} (command doesn't exist or has special handling).`);
                }
                break;
            }
            default:
                await this.sendChatMessage(twitchBot, channel, 'Invalid action. Use !command <add/edit/delete> !commandname [message]');
            }
            return;
        }

        const args = message.slice(1).split(' ');
        const commandName = '!' + args[0].toLowerCase();
        const command = await this.getCommand(commandName);

        if (!command) return;
        if (command.userLevel === 'mod' && !context.mod && !context.badges?.broadcaster) return;
        if (command.userLevel === 'broadcaster' && !context.badges?.broadcaster) return;

        try {
            if (command.handler && this.specialCommandHandlers[command.handler]) {
                const twitchBotWrapper = {
                    sendMessage: (channel, message) => twitchBot.sendMessage(channel, message),
                    channelPoints: {
                        getCustomRewards: (broadcasterId) => twitchBot.twitchAPI.getCustomRewards(broadcasterId),
                        updateCustomReward: (broadcasterId, rewardId, updates) =>
                            twitchBot.twitchAPI.updateCustomReward(broadcasterId, rewardId, updates)
                    },
                    users: twitchBot.twitchAPI,
                    streams: {
                        getStreamByUserName: (username) => twitchBot.twitchAPI.getStreamByUserName(username)
                    },
                    viewerManager: twitchBot.viewerManager,
                    analyticsManager: twitchBot.analyticsManager,
                    emoteManager: twitchBot.emoteManager
                };
                await this.specialCommandHandlers[command.handler](twitchBotWrapper, channel, context, args.slice(1), commandName);
            } else {
                await twitchBot.sendMessage(channel, command.response);
            }
        } catch (error) {
            console.error(`Error executing command ${commandName}:`, error);
        }
    }

    async sendChatMessage(twitchBot, channel, response) {
        try {
            await twitchBot.sendMessage(channel, response);
        } catch (error) {
            console.error('❌ Error sending chat message:', error);
        }
    }

    async addCommand(name, response, userLevel = 'everyone') {
        try {
            const sql = `
                INSERT INTO commands (command_name, response_text, handler_name, user_level)
                VALUES (?, ?, NULL, ?)
            `;
            await this.dbManager.query(sql, [name.toLowerCase(), response, userLevel]);

            // Update cache
            this.commandCache.set(name.toLowerCase(), {
                response: response,
                handler: null,
                userLevel: userLevel
            });

            return true;
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                return false; // Command already exists
            }
            console.error('❌ Error adding command:', error);
            throw error;
        }
    }

    async editCommand(name, response) {
        try {
            // Check if command exists and doesn't have a handler
            const command = await this.getCommand(name);
            if (!command || command.handler) {
                return false;
            }

            const sql = `
                UPDATE commands
                SET response_text = ?, updated_at = CURRENT_TIMESTAMP
                WHERE command_name = ? AND handler_name IS NULL
            `;
            const result = await this.dbManager.query(sql, [response, name.toLowerCase()]);

            if (result.affectedRows > 0) {
                // Update cache
                this.commandCache.set(name.toLowerCase(), {
                    response: response,
                    handler: null,
                    userLevel: command.userLevel
                });
                return true;
            }
            return false;
        } catch (error) {
            console.error('❌ Error editing command:', error);
            throw error;
        }
    }

    async deleteCommand(name) {
        try {
            // Check if command exists and doesn't have a handler
            const command = await this.getCommand(name);
            if (!command || command.handler) {
                return false;
            }

            const sql = `
                DELETE FROM commands
                WHERE command_name = ? AND handler_name IS NULL
            `;
            const result = await this.dbManager.query(sql, [name.toLowerCase()]);

            if (result.affectedRows > 0) {
                // Remove from cache
                this.commandCache.delete(name.toLowerCase());
                return true;
            }
            return false;
        } catch (error) {
            console.error('❌ Error deleting command:', error);
            throw error;
        }
    }

    async getAllCommands() {
        try {
            const sql = `
                SELECT command_name, response_text, handler_name, user_level, created_at, updated_at
                FROM commands
                ORDER BY command_name
            `;
            return await this.dbManager.query(sql);
        } catch (error) {
            console.error('❌ Error getting all commands:', error);
            return [];
        }
    }
}

module.exports = CommandManager;
