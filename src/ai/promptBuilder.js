// src/ai/promptBuilder.js

class PromptBuilder {
    constructor() {}

    escapeXml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    buildStreamContext(streamContext, userRoles) {
        if (!streamContext) {
            return '<stream_context>\nStream info unavailable\n</stream_context>';
        }

        let context = '<stream_context>\n';
        context += `Broadcaster: ${this.escapeXml(userRoles.broadcaster)}\n`;

        if (userRoles.mods && userRoles.mods.length > 0) {
            const modList = userRoles.mods.map(mod => this.escapeXml(mod)).join(', ');
            context += `Moderators: ${modList}\n`;
        }

        context += `Game: ${this.escapeXml(streamContext.category)}\n`;
        context += `Title: ${this.escapeXml(streamContext.title)}\n`;
        context += `Live Duration: ${this.escapeXml(streamContext.duration)}\n`;
        context += '</stream_context>';

        return context;
    }

    buildChatHistory(chatHistory) {
        if (!chatHistory || chatHistory.length === 0) {
            return '<chat_history>\nNo recent messages\n</chat_history>';
        }

        let history = '<chat_history>\n';

        chatHistory.forEach(msg => {
            // Format timestamp as [HH:MM]
            const time = new Date(msg.message_time);
            const hours = time.getHours().toString().padStart(2, '0');
            const minutes = time.getMinutes().toString().padStart(2, '0');
            const timestamp = `${hours}:${minutes}`;

            // Use natural Twitch chat format: [timestamp] username: message
            history += `[${timestamp}] ${this.escapeXml(msg.username)}: ${this.escapeXml(msg.message_content)}\n`;
        });

        history += '</chat_history>';

        return history;
    }

    buildUserMessage(userQuery, username, streamContext, chatHistory, userRoles) {
        let prompt = '';

        // Add stream context
        prompt += this.buildStreamContext(streamContext, userRoles);
        prompt += '\n\n';

        // Add chat history
        prompt += this.buildChatHistory(chatHistory);
        prompt += '\n\n';

        // Add the actual user query
        prompt += '<user_query>\n';
        prompt += `${this.escapeXml(username)}: ${this.escapeXml(userQuery)}\n`;
        prompt += '</user_query>';

        return prompt;
    }
}

module.exports = PromptBuilder;
