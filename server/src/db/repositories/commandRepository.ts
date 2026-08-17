import { and, eq } from 'drizzle-orm';
import { commands } from '../schema/index.js';
import { ChannelScopedRepository } from './types.js';
import type { UserLevel } from '../../domain/permissions.js';

export interface CommandRecord {
    name: string;
    responseText: string | null;
    handlerName: string | null;
    /** Handler-backed rows only; reconciled from the declaration at load. */
    description: string | null;
    userLevel: UserLevel;
}

export class CommandRepository extends ChannelScopedRepository {
    async listAll(): Promise<CommandRecord[]> {
        const rows = await this.db
            .select({
                name: commands.name,
                responseText: commands.responseText,
                handlerName: commands.handlerName,
                description: commands.description,
                userLevel: commands.userLevel
            })
            .from(commands)
            .where(eq(commands.channelId, this.channelId));

        return rows as CommandRecord[];
    }

    async create(record: CommandRecord): Promise<void> {
        await this.db.insert(commands).values({
            channelId: this.channelId,
            name: record.name.toLowerCase(),
            responseText: record.responseText,
            handlerName: record.handlerName,
            description: record.description,
            userLevel: record.userLevel
        });
    }

    async updateResponse(name: string, responseText: string): Promise<boolean> {
        const updated = await this.db
            .update(commands)
            .set({ responseText, updatedAt: new Date() })
            .where(and(eq(commands.channelId, this.channelId), eq(commands.name, name.toLowerCase())))
            .returning({ name: commands.name });

        return updated.length > 0;
    }

    /** Used to correct a DB row that disagrees with a handler's declared level. */
    /** Corrects a row to match its handler's declared description. */
    async updateDescription(name: string, description: string): Promise<void> {
        await this.db
            .update(commands)
            .set({ description, updatedAt: new Date() })
            .where(and(eq(commands.channelId, this.channelId), eq(commands.name, name.toLowerCase())));
    }

    async updateUserLevel(name: string, userLevel: UserLevel): Promise<void> {
        await this.db
            .update(commands)
            .set({ userLevel, updatedAt: new Date() })
            .where(and(eq(commands.channelId, this.channelId), eq(commands.name, name.toLowerCase())));
    }

    async delete(name: string): Promise<boolean> {
        const deleted = await this.db
            .delete(commands)
            .where(and(eq(commands.channelId, this.channelId), eq(commands.name, name.toLowerCase())))
            .returning({ name: commands.name });

        return deleted.length > 0;
    }
}
