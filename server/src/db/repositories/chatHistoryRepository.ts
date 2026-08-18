import { desc, eq } from 'drizzle-orm';
import { chatMessages, viewers } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';
import type { ChatHistoryEntry } from '../../ai/promptBuilder.js';

/**
 * Recent chat, for AI context.
 *
 * The prompt builder needs the last N messages, so this is the write path that
 * populates `chat_messages` and the read path that serves them back.
 *
 * The cost, stated plainly, is one INSERT per chat message per channel.
 * Commands are included and recorded with the `command` message type, as are
 * fulfilled redemptions. The chat pipeline records every message it sees and
 * only varies the type. At a busy channel's roughly one message per second that
 * is 86k rows per day. The table is indexed on
 * (channel_id, stream_id, message_time) and nothing prunes it, so it grows
 * without bound. Retention is tracked work and it is genuinely needed.
 */
export class ChatHistoryRepository extends ChannelScopedRepository {
    /**
     * @returns oldest-first, which is the order a transcript reads in. The
     * query takes newest-first to use the index, then reverses.
     */
    async recent(limit: number): Promise<ChatHistoryEntry[]> {
        const rows = await this.db
            .select({
                username: viewers.login,
                content: chatMessages.content,
                at: chatMessages.messageTime
            })
            .from(chatMessages)
            .innerJoin(viewers, eq(viewers.twitchUserId, chatMessages.twitchUserId))
            .where(eq(chatMessages.channelId, this.channelId))
            .orderBy(desc(chatMessages.messageTime))
            .limit(limit);

        return rows
            .map((r) => ({ username: r.username, content: r.content ?? '', at: r.at }))
            .reverse();
    }

    /**
     * Records one message.
     *
     * `twitch_user_id` references `viewers` with RESTRICT, so the viewer must
     * exist first. The chat pipeline already upserts the chatter's roles (and
     * therefore the viewer) before reaching here, which is why this can insert
     * directly, and it is also why this must never run before that.
     */
    async record(message: {
        twitchUserId: string;
        content: string;
        messageType: 'message' | 'command' | 'redemption';
        streamId: string | null;
    }): Promise<void> {
        await this.db.insert(chatMessages).values({
            channelId: this.channelId,
            streamId: message.streamId,
            twitchUserId: message.twitchUserId,
            messageType: message.messageType,
            content: message.content,
            messageTime: new Date()
        });
    }
}
