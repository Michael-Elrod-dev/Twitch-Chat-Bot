/**
 * Builds the XML-tagged user message.
 *
 * The escaping is load-bearing rather than cosmetic. Chat is
 * attacker-controlled text, and a viewer who types `</chat_history>` would
 * otherwise be able to close a section early and have the rest of their message
 * read as instructions. Escaping the three XML metacharacters makes that
 * structurally impossible.
 */

export interface StreamContext {
    category: string;
    title: string;
    duration: string;
}

export interface ChatHistoryEntry {
    username: string;
    content: string;
    at: Date;
}

export interface UserRoles {
    broadcaster: string;
    mods: string[];
}

export interface UserProfile {
    username: string;
    context: string;
}

export function escapeXml(text: string | null | undefined): string {
    if (!text) return '';

    // `&` first: escaping it after the others would double-escape the
    // ampersands they introduce.
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function buildStreamContext(context: StreamContext | null, roles: UserRoles): string {
    if (!context) {
        return '<stream_context>\nStream info unavailable\n</stream_context>';
    }

    let out = '<stream_context>\n';
    out += `Broadcaster: ${escapeXml(roles.broadcaster)}\n`;

    if (roles.mods.length > 0) {
        out += `Moderators: ${roles.mods.map(escapeXml).join(', ')}\n`;
    }

    out += `Game: ${escapeXml(context.category)}\n`;
    out += `Title: ${escapeXml(context.title)}\n`;
    out += `Live Duration: ${escapeXml(context.duration)}\n`;
    out += '</stream_context>';

    return out;
}

export function buildChatHistory(history: ChatHistoryEntry[]): string {
    if (history.length === 0) {
        return '<chat_history>\nNo recent messages\n</chat_history>';
    }

    let out = '<chat_history>\n';

    for (const message of history) {
        const hours = message.at.getHours().toString().padStart(2, '0');
        const minutes = message.at.getMinutes().toString().padStart(2, '0');
        out += `[${hours}:${minutes}] ${escapeXml(message.username)}: ${escapeXml(message.content)}\n`;
    }

    out += '</chat_history>';
    return out;
}

export function buildUserProfile(profile: UserProfile | null): string {
    if (!profile?.context) return '';

    return `<user_profile>\nAbout ${escapeXml(profile.username)}:\n${escapeXml(profile.context)}\n</user_profile>`;
}

/** The conversational path: stream context, recent chat, then the question. */
export function buildUserMessage(options: {
    query: string;
    username: string;
    streamContext: StreamContext | null;
    chatHistory: ChatHistoryEntry[];
    roles: UserRoles;
}): string {
    return [
        buildStreamContext(options.streamContext, options.roles),
        buildChatHistory(options.chatHistory),
        `<user_query>\n${escapeXml(options.username)}: ${escapeXml(options.query)}\n</user_query>`
    ].join('\n\n');
}

/** The game path (!advice, !roast): about one person, so no query section. */
export function buildGamePrompt(options: {
    targetUsername: string;
    profile: UserProfile | null;
    streamContext: StreamContext | null;
    chatHistory: ChatHistoryEntry[];
    roles: UserRoles;
}): string {
    const sections = [buildStreamContext(options.streamContext, options.roles)];

    const profile = buildUserProfile(options.profile);
    if (profile) sections.push(profile);

    if (options.chatHistory.length > 0) {
        sections.push(buildChatHistory(options.chatHistory));
    }

    sections.push(`<target_user>\nGenerate response for: ${escapeXml(options.targetUsername)}\n</target_user>`);

    return sections.join('\n\n');
}
