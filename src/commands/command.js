// src/commands/command.js

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

    async execute(context) {
        return await this.handler(context);
    }

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
