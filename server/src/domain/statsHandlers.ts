import type { HandlerRegistry, HandlerContext } from './handlers.js';
import type { AnalyticsRepository } from '../db/repositories/analyticsRepository.js';
import type { ChannelRoleRepository } from '../db/repositories/channelRoleRepository.js';

/**
 * `!chats`, `!topchats` and `!follow`.
 *
 * All three read data this channel already owns. Two notes on where that data
 * comes from:
 *
 *  - `!topchats` reads `chat_totals`, the aggregate that exists for exactly
 *    this question. Grouping and counting the whole `chat_messages` table on
 *    every invocation would cost more every day, because that table grows
 *    without bound and nothing prunes it.
 *  - `!follow` is not a Helix call. It reads `channel_roles.followed_at`, so it
 *    answers only for people this channel has recorded, and it is
 *    channel-relative, because someone can follow one channel and not another.
 */

/** The chat reply reads "Top 5 Most Active Viewers". */
const TOP_N = 5;

export interface StatsHandlerDeps {
    analytics: AnalyticsRepository;
    roles: ChannelRoleRepository;
}

/** `!chats` and `!follow @name`. The target is the argument, or the caller. */
function resolveTarget(context: HandlerContext): string {
    const requested = (context.args[0] ?? '').replace('@', '').trim();
    return requested === '' ? context.chatter.login : requested;
}

export function createStatsHandlers(deps: StatsHandlerDeps): HandlerRegistry {
    return {
        /* Handler names match the rows already in the owner's database. */
        combinedStats: {
            level: 'everyone',
            description: 'Shows how much someone has chatted',
            handler: async (context: HandlerContext): Promise<void> => {
                const target = resolveTarget(context);
                const totals = await deps.analytics.totalsForLogin(target);

                if (!totals) {
                    // Distinct from "0 interactions": we have never seen them.
                    await context.reply(`@${target} has no recorded activity in this channel.`);
                    return;
                }

                await context.reply(
                    `@${totals.login} has ${totals.totalCount} total interactions `
                    + `(${totals.messageCount} messages, ${totals.commandCount} commands, `
                    + `${totals.redemptionCount} redemptions)`
                );
            }
        },

        topStats: {
            level: 'everyone',
            description: 'Lists the most active chatters',
            handler: async (context: HandlerContext): Promise<void> => {
                const top = await deps.analytics.topChatters(TOP_N);

                if (top.length === 0) {
                    await context.reply('No chat activity recorded yet.');
                    return;
                }

                await context.reply(
                    `Top ${top.length} Most Active Viewers: `
                    + top.map((t, i) => `${i + 1}. ${t.login}`).join(' | ')
                );
            }
        },

        followAge: {
            level: 'everyone',
            description: 'Says how long someone has followed',
            handler: async (context: HandlerContext): Promise<void> => {
                const target = resolveTarget(context);
                const record = await deps.roles.findByLogin(target);
                const followedAt = record ? await deps.roles.followedAt(record.twitchUserId) : null;

                if (!followedAt) {
                    await context.reply(
                        `@${target} is not following this channel or follow data is not available.`
                    );
                    return;
                }

                await context.reply(
                    `@${record?.login ?? target} followed on ${formatDate(followedAt)}. `
                    + `${formatElapsed(Date.now() - followedAt.getTime())} ago.`
                );
            }
        }
    };
}

/** MM/DD/YY. */
function formatDate(at: Date): string {
    const month = String(at.getMonth() + 1).padStart(2, '0');
    const day = String(at.getDate()).padStart(2, '0');
    return `${month}/${day}/${String(at.getFullYear()).slice(-2)}`;
}

/**
 * "1 year, 2 days, 3 hours". A duration under a second still reads as
 * "0 seconds" rather than empty.
 */
function formatElapsed(elapsedMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const totalDays = Math.floor(totalHours / 24);

    const parts: string[] = [];
    const push = (value: number, unit: string): void => {
        if (value > 0) parts.push(`${value} ${unit}${value === 1 ? '' : 's'}`);
    };

    push(Math.floor(totalDays / 365), 'year');
    push(totalDays % 365, 'day');
    push(totalHours % 24, 'hour');
    push(totalMinutes % 60, 'minute');

    const seconds = totalSeconds % 60;
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);

    return parts.join(', ');
}
