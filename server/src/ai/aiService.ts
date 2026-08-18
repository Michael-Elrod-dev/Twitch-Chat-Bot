import type { Logger } from '../logger.js';
import type { AiService, AiRequest, AiResult } from '../services/aiService.js';
import type { SettingsService } from '../domain/settings.js';
import type { ChatterRoles } from '../domain/permissions.js';
import type { ClaudeClient } from './claudeClient.js';
import type { ChatHistoryRepository } from '../db/repositories/chatHistoryRepository.js';
import { AiRateLimiter } from './rateLimiter.js';
import { buildUserMessage, buildGamePrompt, type StreamContext, type UserRoles } from './promptBuilder.js';
import { CHAT_SYSTEM_PROMPT, GAME_PROMPTS, CHAT_HISTORY_LIMITS, type GamePromptType } from './prompts.js';
import { withUsageSuffix } from './usageCounter.js';

/**
 * The real AI service, per channel.
 *
 * Every Phase-0 behavior is preserved with channel scope added:
 *   - rate limits by role rank, per channel per stream,
 *   - the usage counter prefixed on the reply,
 *   - XML prompt building with escaping,
 *   - the AI flag checked fail-closed (upstream, in the pipeline),
 *   - a fallback message on failure.
 *
 * The hard rule: **this never throws into the pipeline.** A chat message that
 * triggers the AI must be answerable or silently skipped, never a source of an
 * exception that could stop the session processing subsequent messages.
 */

/** Phase 0's default when a channel has configured nothing. */
export const DEFAULT_FALLBACK_MESSAGE = 'Sorry, I could not come up with anything just now.';

const DEFAULT_MAX_TOKENS = 300;

export interface ChannelAiServiceOptions {
    channelId: string;
    client: ClaudeClient;
    settings: SettingsService;
    history: ChatHistoryRepository;
    rateLimiter: AiRateLimiter;
    logger: Logger;
    /** Resolves the current stream, so limits bucket per stream. Null when offline. */
    currentStreamId: () => string | null;
    /**
     * The live stream's title/category/duration for the prompt. Null offline.
     *
     * Phase 0 put this in every prompt; without it the bot cannot answer "what
     * game is this" or "how long have you been live" with anything true.
     */
    streamContext: () => StreamContext | null;
    broadcasterLogin: string;
    /** Remaining-requests threshold below which the viewer is told. */
    counterThreshold?: number;
    maxTokens?: number;
    fallbackMessage?: string;
}

export class ChannelAiService implements AiService {
    private readonly options: ChannelAiServiceOptions;

    constructor(options: ChannelAiServiceOptions) {
        this.options = options;
    }

    async handleTextRequest(request: AiRequest): Promise<AiResult> {
        return this.run({
            twitchUserId: request.chatter.twitchUserId,
            username: request.chatter.displayName,
            roles: request.roles ?? {
                isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false
            },
            build: async (history, stream, roles) => ({
                system: CHAT_SYSTEM_PROMPT,
                userMessage: buildUserMessage({
                    query: request.prompt,
                    username: request.chatter.displayName,
                    streamContext: stream,
                    chatHistory: history,
                    roles
                })
            }),
            historyLimit: CHAT_HISTORY_LIMITS.chat
        });
    }

    /**
     * `!advice` and `!roast` — about one person rather than a conversation.
     *
     * The prompt is about the TARGET; the allowance is charged to the
     * REQUESTER. Phase 0 conflated the two and charged the target, which made
     * `!roast @victim` a way to burn someone else's budget until they could no
     * longer use the bot. Lead ruling, P1-WP4.4.
     */
    async handleGameRequest(
        type: GamePromptType,
        target: { twitchUserId: string; displayName: string },
        requester: { twitchUserId: string; roles: ChatterRoles }
    ): Promise<AiResult> {
        return this.run({
            twitchUserId: requester.twitchUserId,
            username: target.displayName,
            roles: requester.roles,
            build: async (history, stream, roles) => ({
                system: GAME_PROMPTS[type],
                userMessage: buildGamePrompt({
                    targetUsername: target.displayName,
                    // Profiles arrive with the analytics package; until then the
                    // prompts' "if no profile context exists" branch applies.
                    profile: null,
                    streamContext: stream,
                    chatHistory: history,
                    roles
                })
            }),
            historyLimit: CHAT_HISTORY_LIMITS[type]
        });
    }

    private async run(job: {
        twitchUserId: string;
        username: string;
        roles: ChatterRoles;
        historyLimit: number;
        build: (
            history: Awaited<ReturnType<ChatHistoryRepository['recent']>>,
            stream: StreamContext | null,
            roles: UserRoles
        ) => Promise<{ system: string; userMessage: string }>;
    }): Promise<AiResult> {
        const o = this.options;

        try {
            const streamId = o.currentStreamId();

            const decision = await o.rateLimiter.check(job.twitchUserId, job.roles, streamId);
            if (!decision.allowed) {
                o.logger.debug(
                    { channelId: o.channelId, used: decision.used, limit: decision.limit },
                    'AI request refused by the rate limit'
                );
                return { ok: false, message: `You have used all ${decision.limit} AI requests for this stream.` };
            }

            const history = job.historyLimit > 0
                ? await o.history.recent(job.historyLimit)
                : [];

            const { system, userMessage } = await job.build(history, o.streamContext(), {
                broadcaster: o.broadcasterLogin,
                mods: []
            });

            const completion = await o.client.complete({
                system,
                userMessage,
                maxTokens: o.maxTokens ?? DEFAULT_MAX_TOKENS
            });

            if (!completion.ok || !completion.text) {
                // The channel's fallback, exactly as Phase 0 did: the viewer
                // gets an answer, not silence, and not a stack trace.
                o.logger.warn(
                    { channelId: o.channelId, reason: completion.reason },
                    'AI request failed - using the fallback message'
                );
                return { ok: false, message: o.fallbackMessage ?? DEFAULT_FALLBACK_MESSAGE };
            }

            // Counted only on success. Phase 0 charged for answers, not for
            // outages, and charging for a failure would let a bad API key burn
            // every viewer's budget.
            const used = await o.rateLimiter.record(job.twitchUserId, streamId);

            return {
                ok: true,
                response: withUsageSuffix(completion.text, {
                    used,
                    limit: decision.limit,
                    ...(o.counterThreshold === undefined ? {} : { threshold: o.counterThreshold })
                })
            };
        } catch (err) {
            // The hard rule. Nothing from here reaches the pipeline as an
            // exception; a broken AI path must not stop a channel answering
            // its ordinary commands.
            o.logger.error(
                { channelId: o.channelId, err: (err as Error).message },
                'AI request threw - using the fallback message'
            );
            return { ok: false, message: o.fallbackMessage ?? DEFAULT_FALLBACK_MESSAGE };
        }
    }
}
