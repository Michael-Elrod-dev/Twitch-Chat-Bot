import { desc, eq } from 'drizzle-orm';
import { chatMessages, viewers } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';
import type { ChatHistoryEntry } from '../../ai/promptBuilder.js';

/**
 * Recent chat, for AI context.
 *
 * This is the dependency the AI port surfaced: the prompt builder needs the
 * last N messages, and nothing was writing `chat_messages` — the Phase-0
 * analytics pipeline that populated it has not been ported yet (P1-WP4.3). The
 * minimal write path lives here so the AI has context to work with, and the
 * full analytics pipeline replaces it rather than duplicating it.
 *
 * **Cost, stated plainly:** one INSERT per chat message per channel — commands
 * included, recorded with the `command` message type, and now fulfilled
 * redemptions too. (An earlier version of this comment said "non-command",
 * which was never true of the code below it: the chat pipeline records every
 * message it sees and only varies the type.) At a busy channel's ~1
 * message/second that is 86k rows/day; the table is indexed on
 * (channel_id, stream_id, message_time) and nothing prunes it yet. Retention is
 * a P1-WP4.3 decision, and it needs one — this grows without bound.
 */
export class ChatHistoryRepository extends ChannelScopedRepository {
    /**
     * @returns oldest-first, which is the order a transcript reads in — the
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
     * directly — but it is also why this must never run before that.
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
