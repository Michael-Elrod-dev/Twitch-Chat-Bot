import { useEffect, useMemo, useRef } from 'react';
import { MessageSquare } from 'lucide-react';
import type { LiveChatMessage } from '@almosthadai/shared';

/**
 * The live chat feed.
 *
 * **Ambient, not a log.** New lines arrive at the bottom, the list is capped in
 * memory, and there is deliberately no backfill and no scroll-to-load: the glance
 * from the second monitor, and a broadcaster who missed a line while the app
 * was closed did not miss it, because they were not there. Saying so plainly in
 * the empty copy is better than a feed that pretends to be complete.
 */

/**
 * How many lines stay in memory.
 *
 * A cap rather than a window on a growing array: an app left open through an
 * eight-hour stream at a busy channel would otherwise hold a hundred thousand
 * React nodes for the sake of scrollback nobody can reach.
 */
export const CHAT_FEED_CAP = 200;

/**
 * Adds one line, keeping the feed at its cap.
 *
 * Newest-first in memory so the cap drops the OLDEST line rather than the line
 * that just arrived. That is the opposite of how the feed reads on screen, since
 * `ChatCard` renders it oldest-first, and the two are deliberately separate
 * concerns. The array's order is about what to evict, and the card's is
 * about which way chat flows.
 */
export function appendChatMessage(
    feed: LiveChatMessage[],
    message: LiveChatMessage
): LiveChatMessage[] {
    return [message, ...feed].slice(0, CHAT_FEED_CAP);
}

/** `20:14`. The machine owns timestamps, so they are mono and short. */
function formatTime(at: string): string {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return '--:--';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * `command` reads CMD, `emote` reads EMOTE, and `ai` reads AI.
 *
 * `none` and `skipped` render nothing at all. They are different facts in the
 * contract and the UI treats them the same here on purpose: both mean the bot
 * did not answer, and a chip saying so on every ordinary line would bury the
 * three that matter.
 */
function chipFor(outcome: LiveChatMessage['outcome']): string | null {
    if (outcome === 'command') return 'CMD';
    if (outcome === 'emote') return 'EMOTE';
    if (outcome === 'ai') return 'AI';
    return null;
}

export interface ChatCardProps {
    messages: LiveChatMessage[];
    /** The card header's dot and meta follow the connection, not the channel. */
    connection: 'open' | 'reconnecting' | 'down';
    /** The copy shown when there is nothing to show. */
    emptyCopy: string;
}

export function ChatCard({
    messages,
    connection,
    emptyCopy
}: ChatCardProps): React.JSX.Element {
    /*
     * Oldest at the top, newest at the bottom, which is chat's direction,
     * and the direction the design mock's own markup runs in (its rows read
     * 21:14 down to 21:17). The README's word for the feed is "prepends", which
     * describes the in-memory operation above; reading it as a rendering order
     * put the newest line at the top and the owner caught it immediately.
     */
    const ordered = useMemo(() => [...messages].reverse(), [messages]);

    /*
     * Follow the newest line.
     *
     * The feed is ambient, not a log. It is read by glancing at it while doing
     * something else, so it stays pinned to the bottom rather than asking the
     * broadcaster to chase it. Scrolled on the element rather than via
     * `scrollIntoView`, which would drag the whole page when the card is only
     * partly in view.
     */
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const feed = scrollRef.current;
        if (feed) feed.scrollTop = feed.scrollHeight;
    }, [messages]);

    return (
        <section className="card chat-card">
            <header className="card__header">
                <h2 className="card__title">Chat</h2>
                {connection === 'open'
                    ? <span className="dot dot--healthy" aria-label="Connected" role="img" />
                    : <span className="card__meta">reconnecting...</span>}
            </header>

            {messages.length === 0
                ? (
                    <div className="empty-panel">
                        <span className="empty-panel__glyph" aria-hidden="true">
                            <MessageSquare size={16} />
                        </span>
                        <p className="empty-panel__copy">{emptyCopy}</p>
                    </div>
                )
                : (
                    <div className="chat-feed" ref={scrollRef}>
                        <ol className="chat-feed__list">
                            {ordered.map((message, index) => {
                            const chip = chipFor(message.outcome);

                            return (
                                <li
                                    // The feed has no stable ids, because
                                    // `chat.message` carries none, so position
                                    // plus time is the
                                    // best available key. Lines are only ever added
                                    // at one end and evicted from the other, never
                                    // reordered, so this does not shuffle.
                                    key={`${message.at}-${index}`}
                                    className={`chat-row${message.fromBot ? ' chat-row--bot' : ''}`}
                                >
                                    <span className="chat-row__time">{formatTime(message.at)}</span>
                                    <span className={`chat-row__name chat-row__name--${message.chatter.role}`}>
                                        {message.chatter.displayName || message.chatter.login}
                                    </span>
                                    <span className="chat-row__text">{message.text}</span>
                                    {chip && (
                                        <span className={`chip chip--${chip.toLowerCase()}`}>{chip}</span>
                                    )}
                                </li>
                            );
                            })}
                        </ol>
                    </div>
                )}
        </section>
    );
}
