// src/commands/commandManager.js

const config = require('../config/config');
const logger = require('../logger/logger');
const { loadCommandHandlers } = require('./utils/commandLoader');

const CACHE_KEY = 'cache:commands';

class CommandManager {
    constructor(specialCommandHandlers) {
        this.specialCommandHandlers = specialCommandHandlers;
        this.dbManager = null;
        this.redisManager = null;
        this.commandCache = new Map();
        this.cacheExpiry = null;
        this.cacheTimeout = config.commandCacheInterval;
    }

    static createWithDependencies(dependencies) {
        const handlers = loadCommandHandlers(dependencies);
        const manager = new CommandManager(handlers);
        logger.info('CommandManager', 'Initialized with modular handler system', {
            handlerCount: Object.keys(handlers).length
        });
        return manager;
    }

    async init(dbManager, redisManager = null) {
        this.dbManager = dbManager;
        this.redisManager = redisManager;
        await this.loadCommands();
    }

    getCacheManager() {
        if (this.redisManager && this.redisManager.connected()) {
            return this.redisManager.getCacheManager();
        }
        return null;
    }

    async loadCommands() {
        try {
            const sql = `
                SELECT command_name, response_text, handler_name, user_level
                FROM commands
            `;
            const results = await this.dbManager.query(sql);

            this.commandCache.clear();
            const cacheData = {};

            for (const row of results) {
                const commandData = {
                    response: row.response_text,
                    handler: row.handler_name,
                    userLevel: row.user_level
                };
                this.commandCache.set(row.command_name.toLowerCase(), commandData);
                cacheData[row.command_name.toLowerCase()] = commandData;
            }

            const cacheManager = this.getCacheManager();
            if (cacheManager) {
                await cacheManager.del(CACHE_KEY);
                if (Object.keys(cacheData).length > 0) {
                    await cacheManager.hmset(CACHE_KEY, cacheData);
                    await cacheManager.expire(CACHE_KEY, config.cache.commandsTTL);
                }
                logger.debug('CommandManager', 'Commands cached in Redis', {
                    commandCount: Object.keys(cacheData).length
                });
            }

            this.cacheExpiry = Date.now() + this.cacheTimeout;
            logger.info('CommandManager', 'Commands loaded successfully', {
                commandCount: this.commandCache.size,
                redisEnabled: !!cacheManager
            });
        } catch (error) {
            logger.error('CommandManager', 'Error loading commands', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    async getCommand(commandName) {
        try {
            const normalizedName = commandName.toLowerCase();

            const cacheManager = this.getCacheManager();
            if (cacheManager) {
                const cached = await cacheManager.hget(CACHE_KEY, normalizedName);
                if (cached) {
                    return cached;
                }

                const allCached = await cacheManager.hgetall(CACHE_KEY);
                if (!allCached || Object.keys(allCached).length === 0) {
                    logger.debug('CommandManager', 'Redis cache empty, reloading commands');
                    await this.loadCommands();
                    return this.commandCache.get(normalizedName) || null;
                }

                return null;
            }

            if (Date.now() > this.cacheExpiry) {
                logger.debug('CommandManager', 'Cache expired, reloading commands');
                await this.loadCommands();
            }

            return this.commandCache.get(normalizedName) || null;
        } catch (error) {
            logger.error('CommandManager', 'Error getting command', {
                error: error.message,
                stack: error.stack,
                commandName
            });
            return this.commandCache.get(commandName.toLowerCase()) || null;
        }
    }

    async handleCommand(twitchBot, channel, context, message) {
        if (message === '!command' || message.startsWith('!command ')) {
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
            logger.debug('CommandManager', 'Executing command', {
                commandName,
                userName: context.username,
                hasHandler: !!command.handler
            });

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
                    emoteManager: twitchBot.emoteManager,
                    aiManager: twitchBot.aiManager,
                    currentStreamId: twitchBot.currentStreamId
                };
                await this.specialCommandHandlers[command.handler](twitchBotWrapper, channel, context, args.slice(1), commandName);
                logger.info('CommandManager', 'Special command executed', {
                    commandName,
                    handler: command.handler,
                    userName: context.username
                });
            } else {
                await twitchBot.sendMessage(channel, command.response);
                logger.info('CommandManager', 'Standard command executed', {
                    commandName,
                    userName: context.username
                });
            }
        } catch (error) {
            logger.error('CommandManager', 'Error executing command', {
                error: error.message,
                stack: error.stack,
                commandName,
                userName: context.username
            });
        }
    }

    async sendChatMessage(twitchBot, channel, response) {
        try {
            await twitchBot.sendMessage(channel, response);
        } catch (error) {
            logger.error('CommandManager', 'Error sending chat message', {
                error: error.message,
                stack: error.stack,
                channel,
                response
            });
        }
    }

    async addCommand(name, response, userLevel = 'everyone') {
        try {
            const sql = `
                INSERT INTO commands (command_name, response_text, handler_name, user_level)
                VALUES (?, ?, NULL, ?)
            `;
            await this.dbManager.query(sql, [name.toLowerCase(), response, userLevel]);

            const commandData = {
                response: response,
                handler: null,
                userLevel: userLevel
            };

            this.commandCache.set(name.toLowerCase(), commandData);

            const cacheManager = this.getCacheManager();
            if (cacheManager) {
                await cacheManager.hset(CACHE_KEY, name.toLowerCase(), commandData);
            }

            logger.info('CommandManager', 'Command added successfully', {
                commandName: name,
                userLevel
            });

            return true;
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                logger.debug('CommandManager', 'Command already exists', { commandName: name });
                return false;
            }
            logger.error('CommandManager', 'Error adding command', {
                error: error.message,
                stack: error.stack,
                commandName: name
            });
            throw error;
        }
    }

    async editCommand(name, response) {
        try {
            const command = await this.getCommand(name);
            if (!command || command.handler) {
                logger.debug('CommandManager', 'Cannot edit command - not found or has handler', {
                    commandName: name,
                    exists: !!command,
                    hasHandler: command?.handler
                });
                return false;
            }

            const sql = `
                UPDATE commands
                SET response_text = ?, updated_at = CURRENT_TIMESTAMP
                WHERE command_name = ? AND handler_name IS NULL
            `;
            const result = await this.dbManager.query(sql, [response, name.toLowerCase()]);

            if (result.affectedRows > 0) {
                const commandData = {
                    response: response,
                    handler: null,
                    userLevel: command.userLevel
                };

                this.commandCache.set(name.toLowerCase(), commandData);

                const cacheManager = this.getCacheManager();
                if (cacheManager) {
                    await cacheManager.hset(CACHE_KEY, name.toLowerCase(), commandData);
                }

                logger.info('CommandManager', 'Command edited successfully', {
                    commandName: name
                });
                return true;
            }
            return false;
        } catch (error) {
            logger.error('CommandManager', 'Error editing command', {
                error: error.message,
                stack: error.stack,
                commandName: name
            });
            throw error;
        }
    }

    async deleteCommand(name) {
        try {
            const command = await this.getCommand(name);
            if (!command || command.handler) {
                logger.debug('CommandManager', 'Cannot delete command - not found or has handler', {
                    commandName: name,
                    exists: !!command,
                    hasHandler: command?.handler
                });
                return false;
            }

            const sql = `
                DELETE FROM commands
                WHERE command_name = ? AND handler_name IS NULL
            `;
            const result = await this.dbManager.query(sql, [name.toLowerCase()]);

            if (result.affectedRows > 0) {
                this.commandCache.delete(name.toLowerCase());

                const cacheManager = this.getCacheManager();
                if (cacheManager) {
                    await cacheManager.hdel(CACHE_KEY, name.toLowerCase());
                }

                logger.info('CommandManager', 'Command deleted successfully', {
                    commandName: name
                });
                return true;
            }
            return false;
        } catch (error) {
            logger.error('CommandManager', 'Error deleting command', {
                error: error.message,
                stack: error.stack,
                commandName: name
            });
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
            logger.error('CommandManager', 'Error getting all commands', {
                error: error.message,
                stack: error.stack
            });
            return [];
        }
    }
}

module.exports = CommandManager;
