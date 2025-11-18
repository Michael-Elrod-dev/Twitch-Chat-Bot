// src/commands/command.js

/**
 * Base Command class that all commands should extend or conform to
 * Provides a standardized interface for command definitions
 */
class Command {
    constructor(config) {
        this.name = config.name;
        this.handler = config.handler;
        this.userLevel = config.userLevel || 'everyone';
        this.cooldown = config.cooldown || 0;
        this.dependencies = config.dependencies || [];
        this.description = config.description || '';

        if (!this.name) {
            throw new Error('Command must have a name');
        }

        if (!this.handler) {
            throw new Error('Command must have a handler');
        }
    }

    /**
     * Execute the command
     * @param {Object} context - Command execution context
     * @param {Object} context.twitchBot - Twitch bot wrapper
     * @param {string} context.channel - Channel name
     * @param {Object} context.context - User context (username, mod status, etc.)
     * @param {Array} context.args - Command arguments
     * @param {Object} context.dependencies - Injected dependencies
     */
    async execute(context) {
        return await this.handler(context);
    }

    /**
     * Check if user has permission to execute this command
     * @param {Object} userContext - User context with mod status, badges, etc.
     */
    hasPermission(userContext) {
        switch (this.userLevel) {
        case 'broadcaster':
            return userContext.badges?.broadcaster;
        case 'mod':
            return userContext.mod || userContext.badges?.broadcaster;
        case 'everyone':
        default:
            return true;
        }
    }
}

module.exports = Command;
