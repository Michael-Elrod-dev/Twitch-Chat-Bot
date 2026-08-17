import type { ChatMessageEvent } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import type { CommandManager } from '../domain/commandManager.js';
import type { EmoteManager } from '../domain/emoteManager.js';
import type { SettingsService } from '../domain/settings.js';
import type { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';
import type { AiService } from '../services/aiService.js';
import type { AnalyticsSink, InteractionType } from '../services/analytics.js';
import { chatRoleOf, type ChatterRoles } from '../domain/permissions.js';
import type { EventBus } from '../live/eventBus.js';
import type { ChatHistoryRepository } from '../db/repositories/chatHistoryRepository.js';
import { NULL_EVENT_BUS } from '../live/eventBus.js';

/** What the pipeline decided to do with a message. Returned for tests and tracing. */
export type PipelineOutcome =
    | { action: 'skipped'; reason: 'own_message' | 'reward_attached' }
    | { action: 'command'; command: string; ran: boolean }
    | { action: 'emote'; trigger: string }
    | { action: 'ai'; prompt: string }
    | { action: 'none' };

export interface ChatPipelineOptions {
    channelId: string;
    botTwitchUserId: string;
    /** Names the bot answers to, lowercase. */
    aiTriggers: string[];
    commands: CommandManager;
    emotes: EmoteManager;
    settings: SettingsService;
    roles: ChannelRoleRepository;
    ai: AiService;
    analytics: AnalyticsSink;
    logger: Logger;
    sendMessage: (text: string) => Promise<void>;
    /**
     * Where realtime observers listen. Defaults to a bus that goes nowhere, so
     * a session with no watchers costs nothing and every existing caller keeps
     * working unchanged.
     */
    bus?: EventBus;
    /**
     * Chat persistence for AI context. Omitted means no history is kept — the
     * AI then works from stream context alone.
     */
    history?: ChatHistoryRepository;
    /** Buckets history and rate limits per stream. */
    currentStreamId?: () => string | null;
}

/**
 * The chat message pipeline for one channel.
 *
 * Order is deliberate and every step encodes a Phase-0 finding:
 *   own-message skip -> reward-attached skip -> `!` command dispatch ->
 *   exact emote match -> AI mention detection -> analytics hook.
 *
 * Dedup happens upstream in ChannelSession, because it must cover every event
 * type rather than chat alone.
 */
export class ChatPipeline {
    private readonly options: ChatPipelineOptions;

    constructor(options: ChatPipelineOptions) {
        this.options = options;
    }

    async handle(event: ChatMessageEvent): Promise<PipelineOutcome> {
        const outcome = await this.classify(event);

        // Published after the decision, never before: an observer should see
        // what the bot did, not what it was about to consider doing. Publishing
        // cannot throw - the bus swallows listener failures - so this can never
        // turn a delivered message into a failed one.
        this.publish(event, outcome);

        return outcome;
    }

    private async classify(event: ChatMessageEvent): Promise<PipelineOutcome> {
        const o = this.options;

        // The bot must never react to itself.
        if (event.chatter.twitchUserId === o.botTwitchUserId) {
            return { action: 'skipped', reason: 'own_message' };
        }

        // Reward-attached messages arrive again as redemptions; handling both
        // would double-count and double-respond.
        if (event.rewardId) {
            return { action: 'skipped', reason: 'reward_attached' };
        }

        const roles: ChatterRoles = {
            isModerator: event.chatter.isModerator,
            isVip: event.chatter.isVip,
            isSubscriber: event.chatter.isSubscriber,
            isBroadcaster: event.chatter.isBroadcaster
        };

        // The chat path genuinely knows this chatter's roles, so it is the path
        // allowed to write them (P1-1: the poll path must not).
        await this.recordRoles(event, roles);

        // Persisted AFTER the roles upsert, never before: chat_messages
        // references viewers with RESTRICT, so the viewer has to exist first.
        await this.recordHistory(event);

        const text = event.text.trim();

        // A command is a command even when it names the bot. Phase 0 WP-6 task 5:
        // "!stats almosthadai" was swallowed by the AI path and burned rate limit.
        if (text.startsWith('!')) {
            const outcome = await this.dispatchCommand(event, text, roles);
            await this.record(event, 'command');
            return outcome;
        }

        const emoteResponse = await o.emotes.match(text);
        if (emoteResponse !== null) {
            await o.sendMessage(emoteResponse);
            await this.record(event, 'message');
            return { action: 'emote', trigger: text.toLowerCase() };
        }

        const prompt = this.extractAiPrompt(text);
        if (prompt !== null) {
            // Detection only in this package; the model call arrives with the
            // AI domain. The enabled check still runs, and still fails closed.
            if (await o.settings.isAiEnabled()) {
                const result = await o.ai.handleTextRequest({
                    channelId: o.channelId,
                    prompt,
                    chatter: {
                        twitchUserId: event.chatter.twitchUserId,
                        displayName: event.chatter.displayName
                    },
                    roles
                });

                // A refusal still speaks: the rate-limit notice and the
                // fallback both arrive as `message`, and silence would look
                // like the bot being broken rather than being out of budget.
                const reply = result.ok ? result.response : result.message;
                if (reply) await o.sendMessage(reply);
            }
            await this.record(event, 'message');
            return { action: 'ai', prompt };
        }

        await this.record(event, 'message');
        return { action: 'none' };
    }

    private async dispatchCommand(
        event: ChatMessageEvent,
        text: string,
        roles: ChatterRoles
    ): Promise<PipelineOutcome> {
        const o = this.options;
        const parts = text.slice(1).split(/\s+/);
        const name = `!${(parts[0] ?? '').toLowerCase()}`;
        const args = parts.slice(1);

        const command = await o.commands.get(name);
        if (!command) {
            return { action: 'command', command: name, ran: false };
        }

        // Permission is decided here and nowhere else.
        if (!o.commands.canRun(command, roles)) {
            o.logger.debug(
                { channelId: o.channelId, command: name, chatter: event.chatter.login },
                'Command blocked by permission level'
            );
            return { action: 'command', command: name, ran: false };
        }

        if (command.handlerName) {
            const registration = o.commands.getHandler(command.handlerName);
            if (!registration) {
                // A row naming a handler this build does not have. Not fatal, but
                // it means the database and the code disagree.
                o.logger.warn(
                    { channelId: o.channelId, command: name, handler: command.handlerName },
                    'Command references an unknown handler'
                );
                return { action: 'command', command: name, ran: false };
            }

            await registration.handler({
                channelId: o.channelId,
                args,
                chatter: event.chatter,
                reply: o.sendMessage
            });
            return { action: 'command', command: name, ran: true };
        }

        if (command.responseText) {
            await o.sendMessage(command.responseText);
            return { action: 'command', command: name, ran: true };
        }

        return { action: 'command', command: name, ran: false };
    }

    /**
     * @returns the prompt with the trigger removed, or null when the message was
     * not addressed to the bot. A message that is *only* the trigger yields null:
     * there is nothing to answer.
     */
    private extractAiPrompt(text: string): string | null {
        const lower = text.toLowerCase();
        if (!this.options.aiTriggers.some((trigger) => lower.includes(trigger))) {
            return null;
        }

        let prompt = text;
        for (const trigger of this.options.aiTriggers) {
            prompt = prompt.split(new RegExp(escapeRegExp(trigger), 'gi')).join(' ');
        }
        prompt = prompt.replace(/@/g, ' ').replace(/\s+/g, ' ').trim();

        return prompt === '' ? null : prompt;
    }

    /**
     * Records the message for AI context.
     *
     * Best-effort by design: bookkeeping must never stop the bot answering,
     * which is the same rule the roles write follows.
     */
    private async recordHistory(event: ChatMessageEvent): Promise<void> {
        const history = this.options.history;
        if (!history) return;

        try {
            await history.record({
                twitchUserId: event.chatter.twitchUserId,
                content: event.text,
                messageType: event.text.trim().startsWith('!') ? 'command' : 'message',
                streamId: this.options.currentStreamId?.() ?? null
            });
        } catch (err) {
            this.options.logger.warn(
                { channelId: this.options.channelId, err: (err as Error).message },
                'Could not record chat history'
            );
        }
    }

    private publish(event: ChatMessageEvent, outcome: PipelineOutcome): void {
        const o = this.options;

        (o.bus ?? NULL_EVENT_BUS).publish(o.channelId, {
            type: 'chat.message',
            channelId: o.channelId,
            at: new Date().toISOString(),
            chatter: {
                login: event.chatter.login,
                displayName: event.chatter.displayName,
                // Read off the same event flags the permission check uses, via
                // the same precedence function — so the feed cannot disagree
                // with what the pipeline actually let this person do.
                role: chatRoleOf({
                    isModerator: event.chatter.isModerator,
                    isVip: event.chatter.isVip,
                    isSubscriber: event.chatter.isSubscriber,
                    isBroadcaster: event.chatter.isBroadcaster
                })
            },
            text: event.text,
            outcome: outcome.action,
            // Taken from the reason the pipeline actually recorded, not
            // re-derived from the ids: `skipped` covers reward-attached viewer
            // messages too, and marking one of those as the bot's would put the
            // bot's wash on a viewer's line.
            fromBot: outcome.action === 'skipped' && outcome.reason === 'own_message'
        });
    }

    private async recordRoles(event: ChatMessageEvent, roles: ChatterRoles): Promise<void> {
        try {
            await this.options.roles.upsertRoles(
                event.chatter.twitchUserId,
                event.chatter.login,
                roles
            );
        } catch (err) {
            // Never let bookkeeping stop the bot from answering.
            this.options.logger.warn(
                { channelId: this.options.channelId, err: (err as Error).message },
                'Could not record chatter roles'
            );
        }
    }

    private async record(event: ChatMessageEvent, type: InteractionType): Promise<void> {
        try {
            await this.options.analytics.recordInteraction(this.options.channelId, event, type);
        } catch (err) {
            this.options.logger.warn(
                { channelId: this.options.channelId, err: (err as Error).message },
                'Analytics hook failed'
            );
        }
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
