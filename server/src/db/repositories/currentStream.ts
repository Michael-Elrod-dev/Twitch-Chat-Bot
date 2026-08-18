import { desc, eq, sql as raw, type SQL } from 'drizzle-orm';
import type { Database } from '../client.js';
import { streams } from '../schema/index.js';

/**
 * "Which stream are we talking about", asked once and answered once.
 *
 * Two screens ask it. The dashboard asks so its four figures describe a stream,
 * and the analytics screen asks so its `this_stream` chip has a window. They
 * must agree. The owner clicks between the two panes in the same second, and a
 * message count that changes because the pane changed is a bug they would report
 * as "the numbers are wrong" with no way to say which one.
 *
 * The definition lives here rather than in each repository because two separate
 * `order by` clauses differ in exactly the case that matters. A crash leaves an
 * older stream row open, a newer stream starts and finishes, and then
 * `ended_at is null` picks the older one while `max(started_at)` picks the
 * newer. Two comments claiming "the same rule" can both be true of the intent
 * and false of the SQL, which is what one shared definition removes.
 *
 * The ordering, in one place:
 * 1. Open streams first (`ended_at is not null` ascending, since false sorts
 *    first). A stream in progress is what "this stream" means while it is
 *    running, and it is not always the one with the latest `started_at`.
 * 2. Then newest by `started_at`. Inside the open set this picks the live one
 *    over a stale row a crash left behind, and inside the closed set it picks
 *    the last one the channel finished, which is what the offline dashboard's
 *    `Last stream` caption captions.
 */
export const CURRENT_STREAM_ORDER: SQL[] = [
    raw`${streams.endedAt} is not null`,
    desc(streams.startedAt)
];

export interface CurrentStreamRow {
    id: string;
    startedAt: Date;
    endedAt: Date | null;
}

/**
 * The open stream, or the most recent finished one, or null for a channel that
 * has never streamed with the bot connected.
 *
 * Channel-scoped by argument rather than by inheritance because both callers are
 * already channel-scoped repositories and this is the query they share, not a
 * third repository they both own.
 */
export async function resolveCurrentStream(
    db: Database,
    channelId: string
): Promise<CurrentStreamRow | null> {
    const [row] = await db
        .select({
            id: streams.id,
            startedAt: streams.startedAt,
            endedAt: streams.endedAt
        })
        .from(streams)
        .where(eq(streams.channelId, channelId))
        .orderBy(...CURRENT_STREAM_ORDER)
        .limit(1);

    return row ?? null;
}
