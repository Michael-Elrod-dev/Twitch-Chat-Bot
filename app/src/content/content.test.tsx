import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Command, Emote, Quote } from '@almosthadai/shared';
import { memorySessionStorage } from '../auth/sessionStore.js';
import { Commands, filterCommands, isBuiltIn } from './Commands.js';
import { Emotes } from './Emotes.js';
import { Quotes } from './Quotes.js';
import { presentError } from './errorPresentation.js';
import { ApiError } from '../api/client.js';

/**
 * The three content screens, against a stubbed API.
 *
 * The seam stubbed is the network and nothing else: every component, hook and
 * schema between the click and the request is the production path. That is what
 * makes an optimistic-rollback assertion worth making. The rollback under test
 * is the one that will actually run.
 */

const session = () => memorySessionStorage({ accessToken: 'token', refreshToken: 'r' });

/*
 * Deliberately NOT one of `!discord` / `!socials` / `!schedule`: those three are
 * the empty state's suggestion chips, which render the moment the last of your
 * own commands is deleted, so a fixture sharing a name with one of them makes
 * "the row is gone" unassertable.
 */
const command = (over: Partial<Command> = {}): Command => ({
    name: '!links',
    responseText: 'discord.gg/example',
    handlerName: null,
    description: null,
    userLevel: 'everyone',
    ...over
});

const page = <T,>(items: T[]) => ({ ok: true, data: { items, total: items.length, limit: 200, offset: 0 } });

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records every write so a test can assert what was actually sent. */
interface Api {
    calls: { method: string; url: string; body: unknown }[];
}

function stubApi(routes: {
    commands?: Command[];
    emotes?: Emote[];
    quotes?: Quote[];
    onWrite?: (method: string, url: string) => Response;
}): Api {
    const calls: Api['calls'] = [];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;

        if (method === 'GET') {
            if (url.includes('/quotes/random')) return json({ ok: true, data: routes.quotes?.[0] });
            if (url.includes('/commands')) return json(page(routes.commands ?? []));
            if (url.includes('/emotes')) return json(page(routes.emotes ?? []));
            if (url.includes('/quotes')) return json(page(routes.quotes ?? []));
        }

        calls.push({ method, url, body });
        return routes.onWrite?.(method, url) ?? json({ ok: true, data: body ?? null }, 201);
    }));

    return { calls };
}

afterEach(() => { vi.unstubAllGlobals(); });

// ---- the error presentation ------------------------------------------------

describe('the one error presentation', () => {
    it('puts what the user typed beside what they typed', () => {
        // `conflict` is a fact about a field. A banner would make them hunt.
        expect(presentError(new ApiError('conflict', '!discord already exists')).placement).toBe('field');
        expect(presentError(new ApiError('bad_request', 'invalid')).placement).toBe('field');
    });

    it('banners what the user did not cause and cannot fix by typing', () => {
        for (const code of ['unauthorized', 'unavailable', 'internal', 'forbidden', 'not_found'] as const) {
            expect(presentError(new ApiError(code, 'nope')).placement).toBe('banner');
        }
    });

    it('keeps rate limiting non-scary, and says how long', () => {
        // Being asked to wait is the system working, not an error state.
        const presented = presentError(new ApiError('rate_limited', 'slow down', 9));

        expect(presented.placement).toBe('inline');
        expect(presented.message).toContain('9s');
        expect(presented.retryAfterSeconds).toBe(9);
    });

    it('degrades a non-ApiError to a banner without leaking internals', () => {
        const presented = presentError(new TypeError('x.y is not a function'));

        expect(presented.placement).toBe('banner');
        expect(presented.message).toBe('Something went wrong');
    });
});

// ---- commands --------------------------------------------------------------

describe('Commands', () => {
    it('separates what you wrote from what is built in', () => {
        const all = [command(), command({ name: '!uptime', responseText: null, handlerName: 'uptime' })];

        expect(isBuiltIn(all[1] as Command)).toBe(true);
        expect(filterCommands(all, 'yours', '').map((c) => c.name)).toEqual(['!links']);
        expect(filterCommands(all, 'built-in', '').map((c) => c.name)).toEqual(['!uptime']);
        expect(filterCommands(all, 'all', '')).toHaveLength(2);
    });

    it('searches the behavior text of a built-in, not just its name', () => {
        // People look for "the one about uptime" as often as for `!uptime`.
        // The text is the server's, not a map in this workspace, so the
        // fixture supplies it the way the API does.
        const all = [command({
            name: '!u', responseText: null,
            handlerName: 'uptime', description: 'Says how long the stream has been live'
        })];
        expect(filterCommands(all, 'all', 'how long the stream')).toHaveLength(1);
    });

    it('renders a built-in as locked, with its behavior and no edit affordance', async () => {
        // A static command too, so the list renders rather than the empty state.
        stubApi({ commands: [
            command(),
            command({
                name: '!uptime', responseText: null,
                handlerName: 'uptime', description: 'Says how long the stream has been live'
            })
        ] });
        render(<Commands storage={session()} />);

        expect(await screen.findByText('!uptime')).toBeInTheDocument();
        expect(screen.getByText('BUILT IN')).toBeInTheDocument();
        expect(screen.getByText('Says how long the stream has been live')).toBeInTheDocument();
        expect(screen.getByLabelText('Built in, not editable')).toBeInTheDocument();
        // Not a disabled pencil. There is no edit control on the built-in row
        // at all. (The static row above it has one, which is the contrast.)
        expect(screen.queryByRole('button', { name: 'Edit !uptime' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Edit !links' })).toBeInTheDocument();
    });

    it('counts yours and built-in in the header', async () => {
        stubApi({
            commands: [command(), command({ name: '!uptime', responseText: null, handlerName: 'uptime' })]
        });
        render(<Commands storage={session()} />);

        expect(await screen.findByText('1 yours, 1 built in')).toBeInTheDocument();
    });

    it('shows the empty state when nothing is yours, listing the built-ins that work anyway', async () => {
        stubApi({ commands: [command({ name: '!uptime', responseText: null, handlerName: 'uptime' })] });
        render(<Commands storage={session()} />);

        expect(await screen.findByText('You have not written any yet')).toBeInTheDocument();
        expect(screen.getByText('Already working, nothing to set up')).toBeInTheDocument();
        for (const suggestion of ['!discord', '!socials', '!schedule']) {
            expect(screen.getByText(suggestion)).toBeInTheDocument();
        }
    });

    it('shows the built-ins when asked for them, even with none of your own', async () => {
        /*
         * The empty state answers "you have not written any yet". A broadcaster
         * who has written none and clicks "Built in" is asking for a list, and
         * covering it with that card answers a question they did not ask.
         * Found by a test failing for the wrong reason, and this is the test for
         * the fix rather than the fix's side effect.
         */
        stubApi({ commands: [command({ name: '!uptime', responseText: null, handlerName: 'uptime' })] });
        render(<Commands storage={session()} />);
        await screen.findByText('You have not written any yet');

        await userEvent.click(screen.getByRole('button', { name: 'Built in' }));

        expect(screen.getByText('!uptime')).toBeInTheDocument();
        expect(screen.queryByText('You have not written any yet')).not.toBeInTheDocument();
    });

    it('creates a command, sending the schema normalized name', async () => {
        const api = stubApi({ commands: [command()] });
        render(<Commands storage={session()} />);
        await screen.findByText('!links');

        await userEvent.click(screen.getByRole('button', { name: 'New command' }));
        await userEvent.type(screen.getByPlaceholderText('!discord'), '!SOCIALS');
        const textarea = document.querySelector('.field__textarea') as HTMLTextAreaElement;
        await userEvent.type(textarea, 'follow me');
        await userEvent.click(screen.getByRole('button', { name: 'Save command' }));

        await waitFor(() => { expect(api.calls).toHaveLength(1); });
        // Lowercased: the pipeline looks commands up lowercased, so `!SOCIALS`
        // would be stored and never matched.
        expect(api.calls[0]?.body).toMatchObject({ name: '!socials', responseText: 'follow me' });
    });

    it('surfaces a conflict on the name field, not in a banner', async () => {
        stubApi({
            commands: [command()],
            onWrite: () => json({ ok: false, error: { code: 'conflict', message: '!discord already exists' } }, 409)
        });
        render(<Commands storage={session()} />);
        await screen.findByText('!links');

        await userEvent.click(screen.getByRole('button', { name: 'New command' }));
        await userEvent.type(screen.getByPlaceholderText('!discord'), '!discord');
        await userEvent.type(document.querySelector('.field__textarea') as HTMLTextAreaElement, 'x');
        await userEvent.click(screen.getByRole('button', { name: 'Save command' }));

        // Beside the name, and the modal stays open so it can be corrected.
        expect(await screen.findByText('!discord already exists')).toBeInTheDocument();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('refuses an invalid name before it reaches the server', async () => {
        const api = stubApi({ commands: [command()] });
        render(<Commands storage={session()} />);
        await screen.findByText('!links');

        await userEvent.click(screen.getByRole('button', { name: 'New command' }));
        await userEvent.type(screen.getByPlaceholderText('!discord'), 'nobang');
        await userEvent.type(document.querySelector('.field__textarea') as HTMLTextAreaElement, 'x');
        await userEvent.click(screen.getByRole('button', { name: 'Save command' }));

        expect(await screen.findByText('must start with ! and contain no spaces')).toBeInTheDocument();
        expect(api.calls).toHaveLength(0);
    });

    it('cannot rename an existing command, because the API has no rename', async () => {
        stubApi({ commands: [command()] });
        render(<Commands storage={session()} />);
        await screen.findByText('!links');

        await userEvent.click(screen.getByRole('button', { name: 'Edit !links' }));

        expect(screen.getByDisplayValue('!links')).toBeDisabled();
    });

    it('deletes optimistically', async () => {
        const api = stubApi({ commands: [command()], onWrite: () => new Response(null, { status: 204 }) });
        render(<Commands storage={session()} />);
        await screen.findByText('!links');

        await userEvent.click(screen.getByRole('button', { name: 'Delete !links' }));

        await waitFor(() => { expect(screen.queryByText('!links')).not.toBeInTheDocument(); });
        expect(api.calls[0]?.method).toBe('DELETE');
    });

    it('puts the row back when the server refuses the delete', async () => {
        // The half of "optimistic" that gets forgotten. A list that never
        // rolls back lies about what was saved.
        stubApi({
            commands: [command()],
            onWrite: () => json({ ok: false, error: { code: 'internal', message: 'Request failed' } }, 500)
        });
        render(<Commands storage={session()} />);
        await screen.findByText('!links');

        await userEvent.click(screen.getByRole('button', { name: 'Delete !links' }));

        await waitFor(() => { expect(screen.getByText('Request failed')).toBeInTheDocument(); });
        expect(screen.getByText('!links')).toBeInTheDocument();
    });

    it('treats deleting something already gone as done, not as a failure', async () => {
        // The row is already where the user wanted it. Rolling it back so they
        // can delete it again would be pedantry about a race they cannot see.
        stubApi({
            commands: [command()],
            onWrite: () => json({ ok: false, error: { code: 'not_found', message: 'No such command' } }, 404)
        });
        render(<Commands storage={session()} />);
        await screen.findByText('!links');

        await userEvent.click(screen.getByRole('button', { name: 'Delete !links' }));

        await waitFor(() => { expect(screen.queryByText('!links')).not.toBeInTheDocument(); });
        expect(screen.queryByText('No such command')).not.toBeInTheDocument();
    });
});

// ---- emotes ----------------------------------------------------------------

describe('Emotes', () => {
    const emote = (over: Partial<Emote> = {}): Emote => ({ triggerText: 'kekw', responseText: 'KEKW', ...over });

    it('adds from the first row rather than a modal', async () => {
        const api = stubApi({ emotes: [] });
        render(<Emotes storage={session()} />);

        // The composer is present with no dialog anywhere.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        await userEvent.type(screen.getByLabelText('Trigger'), 'KEKW');
        await userEvent.type(screen.getByLabelText('Reply'), 'laughs');
        await userEvent.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => { expect(api.calls).toHaveLength(1); });
        // Lowercased and trimmed: matching is exact and on the lowercased text.
        expect(api.calls[0]?.body).toEqual({ triggerText: 'kekw', responseText: 'laughs' });
    });

    it('clears the composer after a successful add', async () => {
        stubApi({ emotes: [] });
        render(<Emotes storage={session()} />);

        await userEvent.type(screen.getByLabelText('Trigger'), 'kekw');
        await userEvent.type(screen.getByLabelText('Reply'), 'laughs');
        await userEvent.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => { expect(screen.getByLabelText('Trigger')).toHaveValue(''); });
    });

    it('offers no edit path, because delete and re-add is the model', async () => {
        stubApi({ emotes: [emote()] });
        render(<Emotes storage={session()} />);

        expect(await screen.findByText('kekw')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete kekw' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    });

    it('carries the exact-match footnote verbatim', async () => {
        stubApi({ emotes: [emote()] });
        render(<Emotes storage={session()} />);

        expect(await screen.findByText(
            'Exact match only. A message has to be just the trigger, nothing around it.'
        )).toBeInTheDocument();
    });

    it('rolls a failed add back out of the list', async () => {
        stubApi({
            emotes: [],
            onWrite: () => json({ ok: false, error: { code: 'conflict', message: 'kekw already exists' } }, 409)
        });
        render(<Emotes storage={session()} />);

        await userEvent.type(screen.getByLabelText('Trigger'), 'kekw');
        await userEvent.type(screen.getByLabelText('Reply'), 'laughs');
        await userEvent.click(screen.getByRole('button', { name: 'Add' }));

        expect(await screen.findByText('kekw already exists')).toBeInTheDocument();
        // The optimistic row is gone again, so the list matches the server.
        expect(document.querySelectorAll('.list-row:not(.list-row--composer)')).toHaveLength(0);
    });
});

// ---- quotes ----------------------------------------------------------------

describe('Quotes', () => {
    const quote = (over: Partial<Quote> = {}): Quote => ({
        quoteNumber: 7, quoteText: 'something wise', author: 'Someone', ...over
    });

    it('shows the retired-number gaps and says why', async () => {
        // #8 is missing on purpose; the footnote is what stops it reading as a bug.
        stubApi({ quotes: [quote({ quoteNumber: 7 }), quote({ quoteNumber: 9 })] });
        render(<Quotes storage={session()} />);

        expect(await screen.findByText('#7')).toBeInTheDocument();
        expect(screen.getByText('#9')).toBeInTheDocument();
        expect(screen.queryByText('#8')).not.toBeInTheDocument();
        expect(screen.getByText(
            'Numbers stick. #7 stays #7 forever, so old clips never point at the wrong quote.'
        )).toBeInTheDocument();
    });

    it('renders the author when there is one and nothing when there is not', async () => {
        stubApi({ quotes: [quote(), quote({ quoteNumber: 8, author: null })] });
        render(<Quotes storage={session()} />);

        expect(await screen.findByText('- Someone')).toBeInTheDocument();
        expect(screen.getAllByText(/^-/)).toHaveLength(1);
    });

    it('deletes permanently and optimistically', async () => {
        const api = stubApi({ quotes: [quote()], onWrite: () => new Response(null, { status: 204 }) });
        render(<Quotes storage={session()} />);
        await screen.findByText('#7');

        await userEvent.click(screen.getByRole('button', { name: 'Delete quote 7' }));

        await waitFor(() => { expect(screen.queryByText('#7')).not.toBeInTheDocument(); });
        expect(api.calls[0]?.method).toBe('DELETE');
    });

    it('adds a quote and lets the server assign the number', async () => {
        const api = stubApi({ quotes: [] });
        render(<Quotes storage={session()} />);

        await userEvent.click(screen.getByRole('button', { name: 'Add quote' }));
        await userEvent.type(screen.getByLabelText('Quote'), 'a new one');
        await userEvent.click(screen.getByRole('button', { name: 'Save quote' }));

        await waitFor(() => { expect(api.calls).toHaveLength(1); });
        // No number is sent: guessing max+1 would be wrong the moment two race.
        expect(api.calls[0]?.body).toEqual({ quoteText: 'a new one', author: null });
    });

    it('highlights the Random pick rather than moving the page around', async () => {
        stubApi({ quotes: [quote({ quoteNumber: 7 })] });
        render(<Quotes storage={session()} />);
        await screen.findByText('#7');

        await userEvent.click(screen.getByRole('button', { name: /Random/ }));

        await waitFor(() => {
            expect(document.querySelector('.quote-card--highlighted')).not.toBeNull();
        });
    });
});
