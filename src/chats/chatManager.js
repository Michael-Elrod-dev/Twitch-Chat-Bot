// src/chats/chatManager.js
const path = require('path');
const fs = require('fs').promises;
const config = require('../config/config');

class ChatManager {
    constructor() {
        this.chattersPath = path.join(config.dataPath, 'chatters.json');
        this.chatters = {};
        this.loadChatters();
    }

    async loadChatters() {
        try {
            const data = await fs.readFile(this.chattersPath, 'utf8');
            if (!data.trim()) {
                this.chatters = {};
                await this.saveChatters();
                return;
            }
            this.chatters = JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await this.saveChatters();
            } else {
                console.error('❌ Error loading chatters:', error);
                this.chatters = {};
            }
        }
    }

    async saveChatters() {
        try {
            await fs.writeFile(this.chattersPath, JSON.stringify(this.chatters, null, 2));
        } catch (error) {
            console.error('❌ Error saving chatters:', error);
        }
    }

    async incrementMessageCount(username, type) {
        try {
            if (!username) {
                console.error('Attempted to increment count for undefined username');
                return;
            }

            // Find existing user case-insensitively
            const existingUser = Object.keys(this.chatters).find(
                name => name.toLowerCase() === username.toLowerCase()
            );

            // Use existing case-sensitive name if found, otherwise use new name
            const userKey = existingUser || username;

            if (!this.chatters[userKey]) {
                this.chatters[userKey] = {
                    messages: 0,
                    commands: 0,
                    redemptions: 0
                };
            }
            
            switch(type) {
                case 'message':
                    this.chatters[userKey].messages += 1;
                    break;
                case 'command':
                    this.chatters[userKey].commands += 1;
                    break;
                case 'redemption':
                    this.chatters[userKey].redemptions += 1;
                    break;
                default:
                    console.error(`Unknown message type: ${type}`);
                    return;
            }

            await this.saveChatters();
        } catch (error) {
            console.error(`Error incrementing ${type} count for ${username}:`, error);
        }
    }

    getUserMessages(username) {
        const stats = this.getChatterStats(username);
        return stats ? stats.messages : 0;
    }
    
    getUserCommands(username) {
        const stats = this.getChatterStats(username);
        return stats ? stats.commands : 0;
    }
    
    getUserRedemptions(username) {
        const stats = this.getChatterStats(username);
        return stats ? stats.redemptions : 0;
    }
    
    getUserTotal(username) {
        const stats = this.getChatterStats(username);
        if (!stats) return 0;
        return stats.messages + stats.commands + stats.redemptions;
    }
    
    getTopFiveUsers() {
        return Object.entries(this.chatters)
            .map(([username, stats]) => ({
                username,
                total: stats.messages + stats.commands + stats.redemptions
            }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 5)
            .map((user, index) => 
                `${index + 1}. ${user.username}: ${user.total} total interactions`
            );
    }
    
    getChatterStats(username) {
        if (!username) {
            console.error('Attempted to get stats for undefined username');
            return null;
        }
        
        const existingUser = Object.keys(this.chatters).find(
            name => name.toLowerCase() === username.toLowerCase()
        );
        
        return existingUser ? this.chatters[existingUser] : null;
    }
}

module.exports = ChatManager;