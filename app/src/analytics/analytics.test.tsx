import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnalyticsSummary } from '@almosthadai/shared';
import { memorySessionStorage } from '../auth/sessionStore.js';
import { Analytics } from './Analytics.js';
import { formatStreamDay, formatStreamLength, TREND_THRESHOLD } from './analyticsFormat.js';

/**
 * Analytics (`3d`).
 *
 * The screen's one non-obvious rule: **the small numbers are the design.** This
 * channel's history starts in August 2026, so four streams and a five-name list
 * are facts about a young channel rather than a failure to have data — and the
 * tests here mostly assert what is NOT rendered: no apology, no "not enough data
 * yet", no zeroes standing in for a request that did not land.
 */

const session = () => memorySessionStorage({ accessToken: 'token', refreshToken: 'r' });

const summary = (over: Partial<AnalyticsSummary> = {}): AnalyticsSummary => ({
    range: 'all_time',
    viewers: 1204,
    messages: 24_806,
    commandsUsed: 3190,
    streams: 4,
    lastStreamAt: '2026-08-14T18:00:00.000Z',
    topChatters: [
        { login: 'mossbucket', messageCount: 3121 },
        { login: 'clipzilla', messageCount: 2408 }
    ],
    recentStreams: [
        {
            startedAt: '2026-08-14T14:00:00.000Z',
            endedAt: '2026-08-14T18:02:00.000Z',
            messages: 6910,
            chatters: 208
        }
    ],
    ...over
});

const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Records the range each request asked for, which is what the chips must change. */
function stubApi(byRange: Partial<Record<string, AnalyticsSummary>>, fallback = summary()): string[] {
    const asked: string[] = [];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const range = new URL(url, 'http://x').searchParams.get('range') ?? 'all_time';
        asked.push(range);
        return json({ ok: true, data: byRange[range] ?? fallback });
    }));

    return asked;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('the analytics formatters', () => {
    it('writes a stream day weekday-first and day before month', () => {
        // 14 Aug 2026 is a FRIDAY. The design's mock draws "Thu 14 Aug" for the same
        // date, which is the mock being a mock — the formatter reports the real day,
        // and this test is what would have caught it going the other way.
        expect(formatStreamDay('2026-08-14T14:00:00.000Z')).toBe('Fri 14 Aug');
        expect(formatStreamDay('nonsense')).toBe('');
    });

    it('writes a length as h and zero-padded m', () => {
        expect(formatStreamLength('2026-08-14T14:00:00.000Z', '2026-08-14T18:02:00.000Z')).toBe('4h 02m');
        // Under an hour drops the hours: `0h 47m` is a length written by a machine.
        expect(formatStreamLength('2026-08-14T14:00:00.000Z', '2026-08-14T14:47:00.000Z')).toBe('47m');
    });

    it('clamps a backwards pair rather than rendering a negative length', () => {
        // Cannot come from the server, which closes a stream after it opens it.
        // A table cell reading `-1h 58m` would be unusable if a clock disagreed.
        expect(formatStreamLength('2026-08-14T18:00:00.000Z', '2026-08-14T14:00:00.000Z')).toBe('0m');
    });
});

describe('Analytics (3d)', () => {
    it('opens on all time, which is the cheap range', async () => {
        // The other two scan the message table; this one reads counters. The
        // default is the one it is for that reason.
        const asked = stubApi({});
        render(<Analytics storage={session()} />);

        await waitFor(() => { expect(asked).toEqual(['all_time']); });
        expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('renders the four figures with thousands separators', async () => {
        stubApi({});
        render(<Analytics storage={session()} />);

        expect(await screen.findByText('24,806')).toBeInTheDocument();
        expect(screen.getByText('1,204')).toBeInTheDocument();
        expect(screen.getByText('3,190')).toBeInTheDocument();
        expect(screen.getByText('4')).toBeInTheDocument();
    });

    it('asks the server for the range the chip names', async () => {
        const asked = stubApi({
            all_time: summary(),
            this_stream: summary({ range: 'this_stream', messages: 812 })
        });
        render(<Analytics storage={session()} />);
        await screen.findByText('24,806');

        await userEvent.click(screen.getByRole('button', { name: 'This stream' }));

        // Both halves: the request changed AND the figure changed. Asserting only
        // the request would pass against a screen that ignored the response.
        await waitFor(() => { expect(asked).toContain('this_stream'); });
        expect(await screen.findByText('812')).toBeInTheDocument();
        expect(screen.queryByText('24,806')).not.toBeInTheDocument();
    });

    it('scales the bars against the busiest chatter, not the total', async () => {
        // A bar drawn as a share of all messages is a hairline for everyone,
        // which is a chart that answers no question.
        stubApi({});
        render(<Analytics storage={session()} />);
        await screen.findByText('3,121');

        const fills = document.querySelectorAll<HTMLElement>('.chatter__bar-fill');
        expect(fills).toHaveLength(2);
        // The browser normalizes a trailing-zero percentage, so this is '100%'.
        expect(fills[0]?.style.width).toBe('100%');
        // 2408 / 3121 — the second bar is a proportion of the first, not of 24,806.
        expect(Number.parseFloat(fills[1]?.style.width ?? '0')).toBeCloseTo(77.15, 1);
    });

    it('renders the streams table with a real length', async () => {
        stubApi({});
        render(<Analytics storage={session()} />);

        expect(await screen.findByText('Fri 14 Aug')).toBeInTheDocument();
        expect(screen.getByText('4h 02m')).toBeInTheDocument();
        expect(screen.getByText('6,910')).toBeInTheDocument();
        expect(screen.getByText('208')).toBeInTheDocument();
    });

    it('says "live" for an open stream rather than a missing length', async () => {
        stubApi({
            all_time: summary({
                recentStreams: [{
                    startedAt: '2026-08-17T14:00:00.000Z', endedAt: null, messages: 42, chatters: 7
                }]
            })
        });
        render(<Analytics storage={session()} />);

        expect(await screen.findByText('live')).toBeInTheDocument();
    });

    it('renders the young-data footer from the real count and drops it at the threshold', async () => {
        const rows: { name: string; streams: number; footer: string | null }[] = [
            { name: 'plural count', streams: 4, footer: `4 streams in. Trends show up around ${TREND_THRESHOLD}.` },
            { name: 'singular count', streams: 1, footer: `One stream in. Trends show up around ${TREND_THRESHOLD}.` },
            // At the threshold the sentence would be false, so it goes away.
            { name: 'at threshold', streams: TREND_THRESHOLD, footer: null }
        ];

        for (const row of rows) {
            stubApi({ all_time: summary({ streams: row.streams }) });
            const { unmount } = render(<Analytics storage={session()} />);

            await screen.findByText('24,806');
            if (row.footer) expect(screen.getByText(row.footer), row.name).toBeInTheDocument();
            else expect(screen.queryByText(/Trends show up around/), row.name).not.toBeInTheDocument();
            unmount();
        }
    });

    it('renders a young channel plainly, with no apology and no empty-state glyph', async () => {
        /*
         * The state every new tenant is in, and the one the handoff is most
         * insistent about. Real zeroes and a plain sentence — not a dashed square,
         * not "no data available", not a suggestion that something is wrong.
         */
        stubApi({
            all_time: summary({
                viewers: 0, messages: 0, commandsUsed: 0, streams: 0,
                lastStreamAt: null, topChatters: [], recentStreams: []
            })
        });
        render(<Analytics storage={session()} />);

        expect(await screen.findByText('The first stream with the bot connected shows up here.'))
            .toBeInTheDocument();
        expect(screen.getByText('Nobody has said anything in this window yet.')).toBeInTheDocument();
        expect(document.querySelector('.empty-panel')).toBeNull();
        // Zeroes, rendered as figures. `4b`'s skeleton is for a server we cannot
        // reach; a channel with nothing to show is not that.
        expect(screen.getAllByText('0')).toHaveLength(4);
        expect(document.querySelector('.number-card__skeleton')).toBeNull();
    });

    it('names the last stream, not a misleading "since"', async () => {
        // `lastStreamAt` is the MOST RECENT stream, so labelling it "since" would
        // claim the figures start after most of the data they include.
        stubApi({ all_time: summary({ lastStreamAt: '2026-08-14T18:00:00.000Z' }) });
        render(<Analytics storage={session()} />);

        expect(await screen.findByText('last stream 14 Aug 2026')).toBeInTheDocument();
        expect(screen.queryByText(/^since/)).not.toBeInTheDocument();
    });

    it('omits the date line before the first stream rather than writing a dash', async () => {
        stubApi({ all_time: summary({ lastStreamAt: null }) });
        render(<Analytics storage={session()} />);

        await screen.findByText('24,806');
        expect(screen.queryByText(/last stream/)).not.toBeInTheDocument();
    });

    it('shows skeletons rather than zeroes while the request is in flight', async () => {
        // The `4b` rule, applied here: a figure of zero is a claim about the
        // channel, and we have not heard back yet.
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => { /* never settles */ })));
        render(<Analytics storage={session()} />);

        expect(document.querySelectorAll('.number-card__skeleton')).toHaveLength(4);
        expect(screen.queryByText('0')).not.toBeInTheDocument();
    });

    it('banners a failed load without blanking the screen', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({ ok: false, error: { code: 'unavailable', message: 'We cannot reach our server' } }),
            { status: 503, headers: { 'content-type': 'application/json' } }
        )));
        render(<Analytics storage={session()} />);

        expect(await screen.findByText('We cannot reach our server')).toBeInTheDocument();
        // Never a full-page error wall over a working bot: the chips are still here.
        expect(screen.getByRole('button', { name: 'Last 7 days' })).toBeInTheDocument();
    });
});
