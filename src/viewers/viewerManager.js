// src/viewers/viewerManager.js
const path = require('path');
const fs = require('fs').promises;
const config = require('../config/config');

class ViewerManager {
    constructor() {
        this.viewersPath = path.join(config.dataPath, 'viewers.json');
        this.viewers = {};
        this.loadViewers();
    }

    async loadViewers() {
        try {
            const data = await fs.readFile(this.viewersPath, 'utf8');
            if (!data.trim()) {
                this.viewers = {};
                await this.saveViewers();
                return;
            }
            this.viewers = JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await this.saveViewers();
            } else {
                console.error('❌ Error loading viewers:', error);
                this.viewers = {};
            }
        }
    }

    async saveViewers() {
        try {
            await fs.writeFile(this.viewersPath, JSON.stringify(this.viewers, null, 2));
        } catch (error) {
            console.error('❌ Error saving viewers:', error);
        }
    }

    async incrementMessageCount(username, type) {
        try {
            if (!username) {
                console.error('Attempted to increment count for undefined username');
                return;
            }

            // Find existing user case-insensitively
            const existingUser = Object.keys(this.viewers).find(
                name => name.toLowerCase() === username.toLowerCase()
            );

            // Use existing case-sensitive name if found, otherwise use new name
            const userKey = existingUser || username;

            if (!this.viewers[userKey]) {
                this.viewers[userKey] = {
                    messages: 0,
                    commands: 0,
                    redemptions: 0
                };
            }
            
            switch(type) {
                case 'message':
                    this.viewers[userKey].messages += 1;
                    break;
                case 'command':
                    this.viewers[userKey].commands += 1;
                    break;
                case 'redemption':
                    this.viewers[userKey].redemptions += 1;
                    break;
                default:
                    console.error(`Unknown message type: ${type}`);
                    return;
            }

            await this.saveViewers();
        } catch (error) {
            console.error(`Error incrementing ${type} count for ${username}:`, error);
        }
    }

    getUserMessages(username) {
        const stats = this.getViewersStats(username);
        return stats ? stats.messages : 0;
    }
    
    getUserCommands(username) {
        const stats = this.getViewersStats(username);
        return stats ? stats.commands : 0;
    }
    
    getUserRedemptions(username) {
        const stats = this.getViewersStats(username);
        return stats ? stats.redemptions : 0;
    }
    
    getUserTotal(username) {
        const stats = this.getViewersStats(username);
        if (!stats) return 0;
        return stats.messages + stats.commands + stats.redemptions;
    }
    
    getTopFiveUsers() {
        return Object.entries(this.viewers)
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
    
    getViewerStats(username) {
        if (!username) {
            console.error('Attempted to get stats for undefined username');
            return null;
        }
        
        const existingUser = Object.keys(this.viewers).find(
            name => name.toLowerCase() === username.toLowerCase()
        );
        
        return existingUser ? this.viewers[existingUser] : null;
    }
}

module.exports = ViewerManager;