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
            const time = new Date(msg.message_time);
            const hours = time.getHours().toString().padStart(2, '0');
            const minutes = time.getMinutes().toString().padStart(2, '0');
            const timestamp = `${hours}:${minutes}`;

            history += `[${timestamp}] ${this.escapeXml(msg.username)}: ${this.escapeXml(msg.message_content)}\n`;
        });

        history += '</chat_history>';

        return history;
    }

    buildUserMessage(userQuery, username, streamContext, chatHistory, userRoles) {
        let prompt = '';

        prompt += this.buildStreamContext(streamContext, userRoles);
        prompt += '\n\n';

        prompt += this.buildChatHistory(chatHistory);
        prompt += '\n\n';

        prompt += '<user_query>\n';
        prompt += `${this.escapeXml(username)}: ${this.escapeXml(userQuery)}\n`;
        prompt += '</user_query>';

        return prompt;
    }

    buildUserProfile(userProfile) {
        if (!userProfile || !userProfile.context) {
            return '';
        }

        let profile = '<user_profile>\n';
        profile += `About ${this.escapeXml(userProfile.username)}:\n`;
        profile += this.escapeXml(userProfile.context);
        profile += '\n</user_profile>';

        return profile;
    }

    buildGamePrompt(targetUsername, userProfile, streamContext, chatHistory, userRoles) {
        let prompt = '';

        prompt += this.buildStreamContext(streamContext, userRoles);
        prompt += '\n\n';

        const profileSection = this.buildUserProfile(userProfile);
        if (profileSection) {
            prompt += profileSection;
            prompt += '\n\n';
        }

        if (chatHistory && chatHistory.length > 0) {
            prompt += this.buildChatHistory(chatHistory);
            prompt += '\n\n';
        }

        prompt += '<target_user>\n';
        prompt += `Generate response for: ${this.escapeXml(targetUsername)}\n`;
        prompt += '</target_user>';

        return prompt;
    }
}

module.exports = PromptBuilder;
