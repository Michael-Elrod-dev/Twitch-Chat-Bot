import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
    ChannelSettings,
    ChannelSummary,
    DashboardSummary,
    LiveChatMessage,
    QueuedSong
} from '@almosthadai/shared';
import type { ConnectionState } from '../live/connection.js';
import { Dashboard } from './Dashboard.js';
import { StatusPill } from '../shell/StatusPill.js';
import { ChatCard, appendChatMessage, CHAT_FEED_CAP } from './ChatCard.js';
import { formatLastStream, resolveNumbers, resolveStatusTiles } from './dashboardState.js';

/**
 * The dashboard in its four states.
 *
 * The load-bearing property throughout is the one the handoff states twice and
 * this app's architecture is built around: **"the server is unreachable" and
 * "the bot is offline" must never be conflated.** Most of what follows is that
 * one rule, asked in every combination that can produce it.
 */

const channel = (over: Partial<ChannelSummary> = {}): ChannelSummary => ({
    id: 'c1', login: 'streamer', displayName: null, status: 'active', enabled: true, ...over
});

const settings = (over: Partial<ChannelSettings> = {}): ChannelSettings => ({
    aiEnabled: true,
    aiLimits: { everyone: 5, vip: 10, subscriber: 15, moderator: 15 },
    songRequestsEnabled: true,
    requestsPlaylistEnabled: false,
    requestsPlaylistName: null,
    discordWebhookConfigured: false,
    spotifyConnected: true,
    ...over
});

const summary = (over: Partial<DashboardSummary> = {}): DashboardSummary => ({
    live: true,
    startedAt: '2026-08-16T18:00:00.000Z',
    numbers: { messages: 4182, chatters: 137, aiReplies: 61, pointsRedeemed: 22 },
    lastStream: { startedAt: '2026-08-16T18:00:00.000Z', endedAt: null },
    ...over
});

const chat = (over: Partial<LiveChatMessage> = {}): LiveChatMessage => ({
    type: 'chat.message',
    channelId: 'c1',
    at: '2026-08-16T20:14:00.000Z',
    chatter: { login: 'viewer', displayName: 'Viewer', role: 'viewer' },
    text: 'hello',
    outcome: 'none',
    fromBot: false,
    ...over
});

const renderDashboard = (props: Partial<Parameters<typeof Dashboard>[0]> = {}) =>
    render(
        <Dashboard
            channel={channel()}
            settings={settings()}
            connection="open"
            summary={summary()}
            live
            messages={[]}
            queue={[]}
            {...props}
        />
    );

/** The tile's reading, by its micro-label. */
const tileValue = (label: string): string => {
    const tile = screen.getByText(label).closest('.status-tile');
    return within(tile as HTMLElement).getByText(/./, { selector: '.status-tile__value' }).textContent ?? '';
};

const tileDot = (label: string): string => {
    const tile = screen.getByText(label).closest('.status-tile') as HTMLElement;
    const dot = tile.querySelector('.dot');
    if (!dot) return tile.querySelector('.status-tile__unknown') ? 'unknown' : 'none';
    return dot.className.replace('dot dot--', '');
};

// ---- THE CENTREPIECE: the tile matrix --------------------------------------

describe('the status strip matrix', () => {
    const CONNECTIONS: ConnectionState[] = ['connecting', 'reconnecting', 'down'];

    describe('every state in which we cannot see the server', () => {
        for (const connection of CONNECTIONS) {
            for (const status of ['active', 'needs_reauth', 'suspended'] as const) {
                for (const enabled of [true, false]) {
                    it(`reads Unknown across the row: ${connection} / ${status} / enabled=${enabled}`, () => {
                        /*
                         * The whole `4b` rule in one assertion, asked eighteen
                         * ways. Whatever we last believed about the channel, an
                         * unreachable server means none of it is current — and
                         * a zero or an "Off" here would be a claim about a bot
                         * that is very likely running perfectly well without us.
                         */
                        const tiles = resolveStatusTiles({
                            connection,
                            channel: { status, enabled },
                            live: true,
                            settings: settings()
                        });

                        expect(tiles.map((t) => t.value)).toEqual(
                            ['Unknown', 'Unknown', 'Unknown', 'Unknown', 'Unknown']
                        );
                        expect(tiles.every((t) => t.dot === 'unknown')).toBe(true);
                    });
                }
            }
        }
    });

    it('live and healthy: the `2a` row', () => {
        renderDashboard();

        expect(tileValue('SESSION')).toBe('Running');
        expect(tileValue('TWITCH')).toBe('Connected');
        expect(tileValue('SPOTIFY')).toBe('Connected');
        expect(tileValue('AI')).toBe('Answering');
        expect(tileValue('DISCORD')).toBe('Not set up');
        expect(tileDot('SESSION')).toBe('healthy');
        expect(tileDot('DISCORD')).toBe('dead');
    });

    it('offline: the same row at rest, not the same row switched off', () => {
        // `2b`. The dots dim and stop; they do not go grey, because the bot is
        // on — it simply has nothing to do.
        renderDashboard({ live: false, summary: summary({ live: false }) });

        expect(tileValue('SESSION')).toBe('Idle');
        expect(tileValue('AI')).toBe('On');
        expect(tileDot('SESSION')).toBe('idle');
        expect(tileDot('TWITCH')).toBe('idle');
    });

    it('needs_reauth: TWITCH alone demands action', () => {
        // `4a`. SESSION is dead and AI is waiting rather than off — the setting
        // is still on, and the bot answers again the moment Twitch lets it.
        renderDashboard({ channel: channel({ status: 'needs_reauth' }) });

        expect(tileValue('SESSION')).toBe('Stopped');
        expect(tileValue('TWITCH')).toBe('Revoked');
        expect(tileValue('AI')).toBe('Waiting');
        expect(tileDot('TWITCH')).toBe('alert');
        expect(tileDot('SESSION')).toBe('dead');
    });

    it('the owner switched the bot off: SESSION says so, and blames nobody else', () => {
        // A state the mocks never drew but the master switch produces at will.
        // TWITCH stays connected: the owner pausing their bot is not Twitch
        // doing anything, and saying "Revoked" here would send them to fix a
        // problem they do not have.
        renderDashboard({ channel: channel({ enabled: false }) });

        expect(tileValue('SESSION')).toBe('Off');
        expect(tileValue('TWITCH')).toBe('Connected');
        expect(tileDot('SESSION')).toBe('dead');
    });

    it('revoked outranks switched-off', () => {
        // Both are true; only one is actionable, and "Off" would hide it.
        const tiles = resolveStatusTiles({
            connection: 'open',
            channel: { status: 'needs_reauth', enabled: false },
            live: true,
            settings: settings()
        });

        expect(tiles[0]?.value).toBe('Stopped');
        expect(tiles[1]?.value).toBe('Revoked');
    });

    it('a live channel with the bot off is not "busy"', () => {
        // The broadcaster is streaming; the bot is not working. The dots follow
        // the bot, which is what this screen is about.
        const tiles = resolveStatusTiles({
            connection: 'open',
            channel: { status: 'active', enabled: false },
            live: true,
            settings: settings()
        });

        expect(tiles.find((t) => t.id === 'twitch')?.dot).toBe('idle');
    });

    it('reflects the settings it is given rather than assuming them', () => {
        renderDashboard({
            settings: settings({
                aiEnabled: false, spotifyConnected: false, discordWebhookConfigured: true
            })
        });

        expect(tileValue('AI')).toBe('Off');
        expect(tileValue('SPOTIFY')).toBe('Not set up');
        expect(tileValue('DISCORD')).toBe('Connected');
    });

    it('staggers the healthy dots so the row shimmers rather than blinking', () => {
        renderDashboard();
        const dots = document.querySelectorAll('.status-tile .dot--healthy');

        const delays = Array.from(dots).map((d) => (d as HTMLElement).style.animationDelay);
        // Distinct, and starting at zero — one shared delay would blink in unison.
        expect(delays[0]).toBe('0s');
        expect(new Set(delays).size).toBeGreaterThan(1);
    });
});

// ---- the header pill, over the same matrix ---------------------------------

describe('the header pill matrix', () => {
    it('renders the uptime only in the live state', () => {
        const { rerender } = render(<StatusPill state="live" uptime="2:14:07" />);
        expect(screen.getByText(/LIVE 2:14:07/)).toBeInTheDocument();

        rerender(<StatusPill state="unknown" uptime="2:14:07" />);
        expect(screen.queryByText(/2:14:07/)).not.toBeInTheDocument();
        expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    });
});

// ---- today's numbers -------------------------------------------------------

describe('the numbers row', () => {
    it('renders the real figures, grouped', () => {
        renderDashboard();
        expect(screen.getByText('4,182')).toBeInTheDocument();
        expect(screen.getByText('137')).toBeInTheDocument();
    });

    it('renders skeletons rather than zeroes when the server is unreachable', () => {
        // The rule this screen exists to honor. A zero is a statement about the
        // bot; the bot is almost certainly fine and we simply cannot see it.
        renderDashboard({ connection: 'down', summary: null });

        expect(screen.queryByText('0')).not.toBeInTheDocument();
        expect(screen.getAllByRole('img', { name: 'Unknown' })).toHaveLength(4);
    });

    it('shows a real zero as a zero', () => {
        // The other half of the same rule: a channel that streamed and nobody
        // came gets an honest 0, not a shrug.
        renderDashboard({
            summary: summary({ numbers: { messages: 0, chatters: 0, aiReplies: 0, pointsRedeemed: 0 } })
        });

        expect(screen.getAllByText('0')).toHaveLength(4);
    });

    it('distinguishes "no server" from "no numbers" at the source', () => {
        expect(resolveNumbers(null).map((c) => c.figure)).toEqual(['?', '?', '?', '?']);
        expect(resolveNumbers({ messages: 0, chatters: 0, aiReplies: 0, pointsRedeemed: 0 })
            .map((c) => c.figure)).toEqual(['0', '0', '0', '0']);
    });

    it('captions the offline numbers with the stream they describe', () => {
        renderDashboard({
            live: false,
            summary: summary({
                live: false,
                lastStream: { startedAt: '2026-08-13T12:00:00.000Z', endedAt: '2026-08-13T16:02:00.000Z' }
            })
        });

        expect(screen.getByText('Last stream')).toBeInTheDocument();
        expect(screen.getByText(/4h 02m/)).toBeInTheDocument();
    });

    it('does not caption the live numbers, which describe the stream in progress', () => {
        renderDashboard();
        expect(screen.queryByText('Last stream')).not.toBeInTheDocument();
    });

    it('says nothing about a channel that has never streamed', () => {
        expect(formatLastStream(null)).toBeNull();
    });

    it('names the day even for a stream still running', () => {
        expect(formatLastStream({ startedAt: '2026-08-13T12:00:00.000Z', endedAt: null }))
            .toMatch(/day$/);
    });
});

// ---- the chat card ---------------------------------------------------------

/**
 * Queries scoped to the chat card.
 *
 * The strip has an `AI` tile and both bottom panels carry reauth copy, so an
 * unscoped `getByText` finds the wrong element and passes for the wrong reason.
 */
const chatCard = (): HTMLElement => document.querySelector('.chat-card') as HTMLElement;

describe('the chat feed', () => {
    it('chips a command and leaves an ordinary line bare', () => {
        renderDashboard({
            messages: [
                chat({ text: '!discord', outcome: 'command' }),
                chat({ text: 'just chatting', outcome: 'none' })
            ]
        });

        expect(within(chatCard()).getByText('CMD')).toBeInTheDocument();
        // Exactly one chip across two lines: the plain one gets none.
        expect(chatCard().querySelectorAll('.chip')).toHaveLength(1);
    });

    it('chips emote and AI answers', () => {
        renderDashboard({
            messages: [chat({ outcome: 'emote' }), chat({ outcome: 'ai' })]
        });

        // The fixture is newest-first (the order the feed holds in memory), so
        // the AI line is the older of the two and renders above the emote.
        const chips = Array.from(chatCard().querySelectorAll('.chip')).map((c) => c.textContent);
        expect(chips).toEqual(['AI', 'EMOTE']);
    });

    it('renders no chip for a deliberately skipped line', () => {
        // `skipped` and `none` are different facts in the contract and the same
        // thing here: the bot did not answer, and a chip saying so on every
        // ordinary line would bury the three that matter.
        renderDashboard({ messages: [chat({ outcome: 'skipped' })] });
        expect(chatCard().querySelectorAll('.chip')).toHaveLength(0);
    });

    it('washes the bot own reply and only that', () => {
        renderDashboard({
            messages: [
                chat({ text: 'bot reply', fromBot: true }),
                // A reward-attached viewer line: also `skipped`, and washing it
                // would tell the broadcaster their viewer was the bot.
                chat({ text: 'viewer redemption', outcome: 'skipped', fromBot: false })
            ]
        });

        // Newest-first in, oldest-first out: the bot line is the newer of the
        // two and therefore the LAST row on screen.
        const rows = document.querySelectorAll('.chat-row');
        expect(rows[1]?.className).toContain('chat-row--bot');
        expect(rows[0]?.className).not.toContain('chat-row--bot');
    });

    it('colors each role from the event, including the moderator green 9a could not do', () => {
        renderDashboard({
            messages: [
                chat({ chatter: { login: 'streamer', displayName: 'Streamer', role: 'broadcaster' } }),
                chat({ chatter: { login: 'someone', displayName: 'Someone', role: 'viewer' } })
            ]
        });

        expect(screen.getByText('Streamer').className).toContain('chat-row__name--broadcaster');
        expect(screen.getByText('Someone').className).toContain('chat-row__name--viewer');
    });

    it('reads oldest at the top and newest at the bottom', () => {
        /*
         * Chat's direction everywhere, and the direction the design mock's own
         * rows run in (21:14 down to 21:17). This shipped backwards: the
         * README's word for the feed is "prepends", which describes the
         * in-memory operation, and reading it as a rendering order put the
         * newest line at the top. The owner caught it in the first minute of
         * using it.
         */
        renderDashboard({
            messages: [
                chat({ text: 'newest', at: '2026-08-16T21:33:00.000Z' }),
                chat({ text: 'middle', at: '2026-08-16T21:32:00.000Z' }),
                chat({ text: 'oldest', at: '2026-08-16T21:31:00.000Z' })
            ]
        });

        const rendered = Array.from(chatCard().querySelectorAll('.chat-row__text'))
            .map((r) => r.textContent);
        expect(rendered).toEqual(['oldest', 'middle', 'newest']);
    });

    it('follows the newest line rather than asking the broadcaster to chase it', () => {
        const { rerender } = render(
            <ChatCard
                messages={[chat({ text: 'first' })]}
                connection="open"
                emptyCopy="empty"
            />
        );

        const feed = document.querySelector('.chat-feed') as HTMLElement;
        // jsdom reports zero heights, so the assertion is that the feed was
        // scrolled to its own full height — the intent, not a pixel value.
        Object.defineProperty(feed, 'scrollHeight', { value: 900, configurable: true });

        rerender(
            <ChatCard
                messages={[chat({ text: 'second' }), chat({ text: 'first' })]}
                connection="open"
                emptyCopy="empty"
            />
        );

        expect(feed.scrollTop).toBe(900);
    });

    it('renders a moderator green - the coloring 9a shipped unable to do', () => {
        /*
         * The rider's whole purpose. Until `role` rode on the event the feed
         * could only compare a login against the channel's, which identifies the
         * broadcaster and nobody else; every moderator rendered as an ordinary
         * viewer, and no test could have caught it because the information was
         * not on the wire to get wrong.
         */
        renderDashboard({
            messages: [
                chat({ chatter: { login: 'modperson', displayName: 'ModPerson', role: 'moderator' } }),
                chat({ chatter: { login: 'vipperson', displayName: 'VipPerson', role: 'vip' } })
            ]
        });

        expect(screen.getByText('ModPerson').className).toContain('chat-row__name--moderator');
        // VIPs share the body color with ordinary viewers, per the handoff.
        expect(screen.getByText('VipPerson').className).toContain('chat-row__name--vip');
        expect(screen.getByText('VipPerson').className).not.toContain('--moderator');
    });

    it('keeps the newest line and evicts the oldest at the cap', () => {
        // Ambient, not a log: an app left open through an eight-hour stream must
        // not hold the whole stream in React nodes.
        let feed: LiveChatMessage[] = [];
        for (let i = 0; i < CHAT_FEED_CAP + 50; i++) {
            feed = appendChatMessage(feed, chat({ text: `line ${i}` }));
        }

        expect(feed).toHaveLength(CHAT_FEED_CAP);
        expect(feed[0]?.text).toBe(`line ${CHAT_FEED_CAP + 49}`);
    });

    it('reads "reconnecting…" rather than showing a healthy dot', () => {
        renderDashboard({ connection: 'reconnecting' });
        expect(screen.getByText('reconnecting…')).toBeInTheDocument();
    });

    it('states plainly that missed lines stay missed', () => {
        // `4b`. The one thing this empty state must not do is imply a backfill.
        renderDashboard({ connection: 'down', summary: null, messages: [chat()] });
        expect(screen.getByText(/stay missed/)).toBeInTheDocument();
    });

    it('drops the stale feed when the server goes away', () => {
        // Lines from before the drop under a "reconnecting" header would read as
        // current traffic.
        renderDashboard({ connection: 'down', summary: null, messages: [chat({ text: 'old line' })] });
        expect(screen.queryByText('old line')).not.toBeInTheDocument();
    });

    it('is optimistic while the channel is merely offline', () => {
        renderDashboard({ live: false, summary: summary({ live: false }) });
        expect(screen.getByText(/second you go live/)).toBeInTheDocument();
    });

    it('explains the silence during a reauth rather than promising traffic', () => {
        renderDashboard({ channel: channel({ status: 'needs_reauth' }) });
        expect(within(chatCard()).getByText(/nothing is coming through/i)).toBeInTheDocument();
    });
});

// ---- the song queue --------------------------------------------------------

describe('the song queue card', () => {
    const song = (id: string): QueuedSong => ({
        id, trackUri: `spotify:track:${id}`, trackName: `Track ${id}`,
        artistName: 'Artist', requestedByLogin: 'viewer', createdAt: '2026-08-16T20:00:00.000Z'
    });

    it('shows both stage labels and no prose under them', () => {
        // These two labels are the entire explanation of the two-stage queue.
        renderDashboard({ queue: [song('a'), song('b')] });

        expect(screen.getByText('PLAYING IN SPOTIFY')).toBeInTheDocument();
        expect(screen.getByText('WAITING IN THE BOT')).toBeInTheDocument();
    });

    it('counts what is waiting', () => {
        renderDashboard({ queue: [song('a'), song('b')] });
        expect(screen.getByText('2 waiting')).toBeInTheDocument();
    });

    it('swaps the count for the REQUESTS OPEN pill when offline', () => {
        renderDashboard({ live: false, summary: summary({ live: false }) });
        expect(screen.getByText('REQUESTS OPEN')).toBeInTheDocument();
    });

    it('does not claim requests are open when they are closed', () => {
        renderDashboard({
            live: false,
            summary: summary({ live: false }),
            settings: settings({ songRequestsEnabled: false })
        });
        expect(screen.queryByText('REQUESTS OPEN')).not.toBeInTheDocument();
    });

    it('does not promise open requests while Twitch has the bot locked out', () => {
        // The setting is on, but nobody can redeem the reward. A viewer told
        // requests were open would spend points on nothing.
        renderDashboard({
            live: false,
            summary: summary({ live: false }),
            channel: channel({ status: 'needs_reauth' })
        });

        expect(screen.queryByText('REQUESTS OPEN')).not.toBeInTheDocument();
    });

    it('reads ? rather than 0 waiting when the server is unreachable', () => {
        renderDashboard({ connection: 'down', summary: null, queue: [song('a')] });
        expect(screen.queryByText(/waiting/)).not.toBeInTheDocument();
    });
});

// ---- the banner region -----------------------------------------------------

describe('the banner', () => {
    it('shows nothing over a healthy dashboard', () => {
        renderDashboard();
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('offers Reconnect Twitch on `4a`', () => {
        const onReconnect = vi.fn();
        renderDashboard({ channel: channel({ status: 'needs_reauth' }), onReconnect });

        expect(screen.getByText('Twitch cut the bot off')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Reconnect Twitch' })).toBeInTheDocument();
    });

    it('fires the reconnect', async () => {
        const onReconnect = vi.fn();
        renderDashboard({ channel: channel({ status: 'needs_reauth' }), onReconnect });

        await userEvent.click(screen.getByRole('button', { name: 'Reconnect Twitch' }));
        expect(onReconnect).toHaveBeenCalledOnce();
    });

    it('shows the neutral unreachable banner on `4b`', () => {
        renderDashboard({ connection: 'down', summary: null });

        expect(screen.getByText('We cannot reach our server')).toBeInTheDocument();
        expect(screen.getByRole('status').className).toContain('banner--neutral');
    });

    it('an unreachable server outranks a revoked token', () => {
        // The reconnect it would offer cannot be started while we cannot reach
        // the server that starts it. Offering a button that must fail is worse
        // than saying plainly what is wrong.
        renderDashboard({
            connection: 'down', summary: null, channel: channel({ status: 'needs_reauth' })
        });

        expect(screen.getByText('We cannot reach our server')).toBeInTheDocument();
        expect(screen.queryByText('Twitch cut the bot off')).not.toBeInTheDocument();
    });

    it('gives auth.error the home it never had in the signed-in shell', () => {
        renderDashboard({ authError: 'Ignored a sign-in this app did not start.' });

        expect(screen.getByRole('status')).toBeInTheDocument();
        expect(screen.getByText('Ignored a sign-in this app did not start.')).toBeInTheDocument();
    });

    it('does not let a sign-in error hide a revoked token', () => {
        renderDashboard({
            channel: channel({ status: 'needs_reauth' }), authError: 'something else'
        });

        expect(screen.getByText('Twitch cut the bot off')).toBeInTheDocument();
    });
});
