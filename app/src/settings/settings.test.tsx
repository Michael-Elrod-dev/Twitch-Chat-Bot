import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
    ApiKeySummary,
    ChannelSettings,
    ChannelSummary,
    ManagedReward,
    SpotifyStatus
} from '@almosthadai/shared';
import { memorySessionStorage } from '../auth/sessionStore.js';
import { Settings } from './Settings.js';
import { APP_VERSION_NUMBER } from '../api/config.js';

/**
 * The five settings panes.
 *
 * Two properties get the hardest tests here, because both are promises the
 * product makes in words and could break silently:
 *
 *  - **The webhook URL is never rendered.** Asserted as a negative over the whole
 *    document, not just the row, so a debug echo anywhere on the page fails.
 *  - **The API key renders exactly once.** Asserted the same way, plus the fact
 *    that closing the modal makes it unrecoverable — there is no route that would
 *    hand it back, so a UI that kept it in state would be the only copy and would
 *    outlive the moment it was meant to exist for.
 */

const session = () => memorySessionStorage({ accessToken: 'token', refreshToken: 'r' });

const settings = (over: Partial<ChannelSettings> = {}): ChannelSettings => ({
    aiEnabled: true,
    aiLimits: { everyone: 3, vip: 5, subscriber: 5, moderator: 10 },
    songRequestsEnabled: true,
    requestsPlaylistEnabled: false,
    requestsPlaylistName: null,
    discordWebhookConfigured: false,
    spotifyConnected: true,
    ...over
});

const channel = (over: Partial<ChannelSummary> = {}): ChannelSummary => ({
    id: 'ch1',
    login: 'almosthad',
    displayName: null,
    status: 'active',
    enabled: true,
    ...over
});

const CONNECTED: SpotifyStatus = {
    connected: true,
    accountName: 'michael',
    connectedSince: '2026-08-04T10:00:00.000Z',
    playlist: null
};

const REWARDS: ManagedReward[] = [
    { kind: 'song_request', title: 'Song Request', bound: true },
    { kind: 'skip_queue', title: 'Skip song queue', bound: true },
    { kind: 'add_quote', title: null, bound: false }
];

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Api { calls: { method: string; url: string; body: unknown }[] }

function stubApi(routes: {
    spotify?: SpotifyStatus;
    rewards?: ManagedReward[];
    keys?: ApiKeySummary[];
    onWrite?: (method: string, url: string) => Response;
} = {}): Api {
    const calls: Api['calls'] = [];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;

        if (method === 'GET') {
            if (url.includes('/spotify')) {
                return json({ ok: true, data: routes.spotify ?? CONNECTED });
            }
            if (url.includes('/rewards')) {
                return json({ ok: true, data: { items: routes.rewards ?? REWARDS } });
            }
            if (url.includes('/api-keys')) {
                const items = routes.keys ?? [];
                return json({ ok: true, data: { items, total: items.length, limit: 50, offset: 0 } });
            }
        }

        calls.push({ method, url, body });
        return routes.onWrite?.(method, url) ?? json({ ok: true, data: body ?? null }, 201);
    }));

    return { calls };
}

const renderSettings = (over: {
    settings?: ChannelSettings | null;
    channel?: ChannelSummary | null;
    onSettingsChange?: (patch: unknown) => Promise<string | null>;
    onDisconnectChannel?: () => Promise<string | null>;
    onSignOut?: () => void;
} = {}): void => {
    render(
        <Settings
            storage={session()}
            channel={over.channel === undefined ? channel() : over.channel}
            settings={over.settings === undefined ? settings() : over.settings}
            onSettingsChange={over.onSettingsChange ?? (async () => null)}
            onSignOut={over.onSignOut ?? (() => undefined)}
            onDisconnectChannel={over.onDisconnectChannel ?? (async () => null)}
            onConnectSpotify={() => undefined}
        />
    );
};

const openPane = async (label: string): Promise<void> => {
    await userEvent.click(screen.getByRole('button', { name: label }));
};

afterEach(() => { vi.unstubAllGlobals(); });

// ---- 3e --------------------------------------------------------------------

describe('Settings · AI (3e)', () => {
    it('opens on AI', () => {
        stubApi();
        renderSettings();

        expect(screen.getByText('AI replies')).toBeInTheDocument();
    });

    it('renders a stepper per editable tier and the broadcaster as a word', () => {
        stubApi();
        renderSettings();

        expect(screen.getByLabelText('Everyone, 3')).toBeInTheDocument();
        expect(screen.getByLabelText('VIPs, 5')).toBeInTheDocument();
        expect(screen.getByLabelText('Subs, 5')).toBeInTheDocument();
        expect(screen.getByLabelText('Mods, 10')).toBeInTheDocument();

        // Unlimited, and NOT a stepper. A field for it would exist only so
        // somebody could one day set it to three by accident.
        expect(screen.getByText('Unlimited')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /for You/ })).not.toBeInTheDocument();
    });

    it('sends all four tiers when one stepper moves', async () => {
        /*
         * The contract accepts nothing else, and the reason is concurrency: a
         * partial merged server-side would resolve two people editing different
         * tiers to whichever request landed second, with the other tier's change
         * lost inside a body that never mentioned it.
         */
        const onSettingsChange = vi.fn(async () => null);
        stubApi();
        renderSettings({ onSettingsChange });

        await userEvent.click(screen.getByRole('button', { name: 'More for Everyone' }));

        expect(onSettingsChange).toHaveBeenCalledWith({
            aiLimits: { everyone: 4, vip: 5, subscriber: 5, moderator: 10 }
        });
    });

    it('allows zero, which turns one tier off and leaves the ones above on', async () => {
        const onSettingsChange = vi.fn(async () => null);
        stubApi();
        renderSettings({
            settings: settings({ aiLimits: { everyone: 1, vip: 5, subscriber: 5, moderator: 10 } }),
            onSettingsChange
        });

        await userEvent.click(screen.getByRole('button', { name: 'Fewer for Everyone' }));

        expect(onSettingsChange).toHaveBeenCalledWith({
            aiLimits: { everyone: 0, vip: 5, subscriber: 5, moderator: 10 }
        });
    });

    it('stops at the floor rather than sending a value the schema refuses', async () => {
        const onSettingsChange = vi.fn(async () => null);
        stubApi();
        renderSettings({
            settings: settings({ aiLimits: { everyone: 0, vip: 5, subscriber: 5, moderator: 10 } }),
            onSettingsChange
        });

        const fewer = screen.getByRole('button', { name: 'Fewer for Everyone' });
        expect(fewer).toBeDisabled();

        await userEvent.click(fewer);
        expect(onSettingsChange).not.toHaveBeenCalled();
    });

    it('places a rejected save inline rather than losing it', async () => {
        stubApi();
        renderSettings({ onSettingsChange: async () => 'Too many changes at once. Try again in 9s.' });

        await userEvent.click(screen.getByRole('button', { name: 'More for Mods' }));

        expect(await screen.findByText('Too many changes at once. Try again in 9s.')).toBeInTheDocument();
    });
});

// ---- 5a --------------------------------------------------------------------

describe('Settings · Songs (5a)', () => {
    it('saves the playlist name on Save, not on every keystroke', async () => {
        /*
         * Saving per keystroke would have the server resolving "S", "St", "Str"…
         * against Spotify — and possibly *creating* a playlist called `S`, since
         * naming one creates it when missing.
         */
        const onSettingsChange = vi.fn(async () => null);
        stubApi();
        renderSettings({ onSettingsChange });
        await openPane('Songs');

        await userEvent.type(await screen.findByPlaceholderText('Stream Requests'), 'Stream Requests');
        expect(onSettingsChange).not.toHaveBeenCalled();

        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSettingsChange).toHaveBeenCalledWith({ requestsPlaylistName: 'Stream Requests' });
    });

    it('confirms in sage, saying what happened rather than "Saved"', async () => {
        stubApi({
            spotify: { ...CONNECTED, playlist: { id: 'p1', name: 'Stream Requests', trackCount: 312 } }
        });
        renderSettings();
        await openPane('Songs');

        await userEvent.type(await screen.findByPlaceholderText('Stream Requests'), 'Stream Requests');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        const confirmation = await screen.findByText(/Saving requests to/);
        expect(confirmation).toHaveTextContent('312 tracks in it');
        expect(confirmation.className).toContain('setting-row__confirm');
    });

    it('says the bot will make the playlist when Spotify has none by that name', async () => {
        // Named but not created is correct and expected — the bot creates it with
        // the first request. Reporting a count would describe a missing playlist.
        stubApi({ spotify: { ...CONNECTED, playlist: null } });
        renderSettings();
        await openPane('Songs');

        await userEvent.type(await screen.findByPlaceholderText('Stream Requests'), 'Fresh List');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByText(/The bot makes “Fresh List” with the first request/))
            .toBeInTheDocument();
    });

    it('refuses an empty name before it reaches the server', async () => {
        const onSettingsChange = vi.fn(async () => null);
        stubApi();
        renderSettings({ onSettingsChange });
        await openPane('Songs');

        await userEvent.click(await screen.findByRole('button', { name: 'Save' }));

        // The schema's own message, and nothing sent.
        expect(await screen.findByText('Give the playlist a name')).toBeInTheDocument();
        expect(onSettingsChange).not.toHaveBeenCalled();
    });

    it('disables both toggles and the field when Spotify is not linked', async () => {
        stubApi({ spotify: { connected: false, accountName: null, connectedSince: null, playlist: null } });
        renderSettings();
        await openPane('Songs');

        expect(await screen.findByRole('switch', { name: 'Let viewers request songs' })).toBeDisabled();
        expect(screen.getByRole('switch', { name: 'Save every request to a playlist' })).toBeDisabled();
        expect(screen.getByPlaceholderText('Stream Requests')).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Connect Spotify' })).toBeInTheDocument();
    });

    it('shows the linked account and the date, day-first', async () => {
        stubApi();
        renderSettings();
        await openPane('Songs');

        expect(await screen.findByText('michael')).toBeInTheDocument();
        expect(screen.getByText('since 4 Aug')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    });
});

// ---- 5b --------------------------------------------------------------------

describe('Settings · Notifications (5b)', () => {
    it('never renders a stored webhook URL, anywhere on the page', async () => {
        /*
         * The negative asserted over the whole document rather than the row, so a
         * debug echo elsewhere would fail this too. It holds structurally as well:
         * `ChannelSettings` carries a boolean, and no route returns the value — but
         * a test that only checked the row would not notice if one started to.
         */
        stubApi();
        renderSettings({ settings: settings({ discordWebhookConfigured: true }) });
        await openPane('Notifications');

        expect(await screen.findByText(/We never show it back to you/)).toBeInTheDocument();
        expect(document.body.textContent).not.toContain('discord.com/api/webhooks');
        expect(document.body.textContent).not.toContain('http');
    });

    it('offers Replace and Clear and no Edit', async () => {
        stubApi();
        renderSettings({ settings: settings({ discordWebhookConfigured: true }) });
        await openPane('Notifications');

        expect(await screen.findByRole('button', { name: 'Replace' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
        // You cannot edit a value you cannot see; a pre-filled field would be
        // either a lie or a leak.
        expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    });

    it('offers Set rather than Replace when none is configured, and no Clear', async () => {
        stubApi();
        renderSettings({ settings: settings({ discordWebhookConfigured: false }) });
        await openPane('Notifications');

        expect(await screen.findByRole('button', { name: 'Set' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    });

    it('sends the URL on save and holds no copy of it afterwards', async () => {
        const onSettingsChange = vi.fn(async () => null);
        stubApi();
        renderSettings({ settings: settings({ discordWebhookConfigured: true }), onSettingsChange });
        await openPane('Notifications');

        await userEvent.click(await screen.findByRole('button', { name: 'Replace' }));
        await userEvent.type(
            screen.getByLabelText('New webhook URL'),
            'https://discord.com/api/webhooks/1/secretvalue'
        );
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(onSettingsChange).toHaveBeenCalledWith({
            discordWebhookUrl: 'https://discord.com/api/webhooks/1/secretvalue'
        });

        /*
         * Re-opened, and the field must be EMPTY.
         *
         * The obvious assertion here — `document.body.textContent` no longer
         * contains the URL — passes for the wrong reason and was written that way
         * first: saving also closes the form, so an unrendered input holds its
         * value invisibly and the negative is satisfied either way. Re-opening is
         * what tells "cleared from state" apart from "merely hidden", which is the
         * difference between the URL being gone and it sitting in a closed form's
         * state for the rest of the session.
         */
        await waitFor(() => {
            expect(screen.queryByLabelText('New webhook URL')).not.toBeInTheDocument();
        });
        await userEvent.click(screen.getByRole('button', { name: 'Replace' }));

        expect(screen.getByLabelText('New webhook URL')).toHaveValue('');
        expect(document.body.textContent).not.toContain('secretvalue');
    });

    it('sends an explicit null to clear, because undefined means "not mentioned"', async () => {
        const onSettingsChange = vi.fn(async () => null);
        stubApi();
        renderSettings({ settings: settings({ discordWebhookConfigured: true }), onSettingsChange });
        await openPane('Notifications');

        await userEvent.click(await screen.findByRole('button', { name: 'Clear' }));

        expect(onSettingsChange).toHaveBeenCalledWith({ discordWebhookUrl: null });
    });

    it('refuses something that is not a URL before it reaches the server', async () => {
        const onSettingsChange = vi.fn(async () => null);
        stubApi();
        renderSettings({ onSettingsChange });
        await openPane('Notifications');

        await userEvent.click(await screen.findByRole('button', { name: 'Set' }));
        await userEvent.type(screen.getByLabelText('New webhook URL'), 'not-a-url');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByText('That is not a webhook URL')).toBeInTheDocument();
        expect(onSettingsChange).not.toHaveBeenCalled();
    });

    it('lists the three managed rewards with the trust line, unbound ones included', async () => {
        stubApi();
        renderSettings();
        await openPane('Notifications');

        expect(await screen.findByText('Song Request')).toBeInTheDocument();
        expect(screen.getByText('Skip song queue')).toBeInTheDocument();
        // Unbound falls back to the kind's label rather than vanishing: the trust
        // claim is only worth making if the list is closed.
        expect(screen.getByText('Add a quote')).toBeInTheDocument();
        expect(screen.getByText('Not set up')).toBeInTheDocument();
        expect(screen.getByText(/only rewards the bot creates or edits/)).toBeInTheDocument();
    });

    it('counts what the bot manages rather than claiming to know the streamer own rewards', async () => {
        // "3 of yours untouched" would be a count of their rewards, which the API
        // deliberately never enumerates — the trust claim rests on not looking.
        stubApi();
        renderSettings();
        await openPane('Notifications');

        expect(await screen.findByText('2 of 3 bound')).toBeInTheDocument();
    });
});

// ---- 3f --------------------------------------------------------------------

describe('Settings · Stream Deck (3f)', () => {
    const key = (over: Partial<ApiKeySummary> = {}): ApiKeySummary => ({
        id: 'k1',
        // Deliberately not "Stream Deck": that is also the sub-nav label, and a
        // fixture sharing a name with the chrome makes "the row rendered"
        // unassertable.
        name: 'Backup deck',
        prefix: 'ahai_7x2f',
        createdAt: '2026-08-12T10:00:00.000Z',
        lastUsedAt: null,
        ...over
    });

    it('lists keys by prefix and never a whole key', async () => {
        stubApi({ keys: [key()] });
        renderSettings();
        await openPane('Stream Deck');

        expect(await screen.findByText('ahai_7x2f…')).toBeInTheDocument();
        expect(screen.getByText('Backup deck')).toBeInTheDocument();
        expect(screen.getByText('12 Aug')).toBeInTheDocument();
        // "never" rather than a dash: an unused key is the one that is safe to
        // revoke, which is worth being able to see.
        expect(screen.getByText('never')).toBeInTheDocument();
    });

    it('states the key exact scope', async () => {
        stubApi({ keys: [key()] });
        renderSettings();
        await openPane('Stream Deck');

        expect(await screen.findByText(/cannot touch commands, quotes or your numbers/))
            .toBeInTheDocument();
    });

    it('shows the key exactly once, and closing discards it', async () => {
        /*
         * THE SHOW-ONCE PIN.
         *
         * `POST /api/v1/api-keys` is the only response that has ever contained the
         * secret and there is no route that would return it, so the modal is not
         * merely where the app chooses to show it — it is the only place it
         * exists. This asserts both halves: it IS rendered once, and after Done
         * it is nowhere in the document and nothing brings it back.
         */
        // Obviously fake and low entropy on purpose. A realistic-looking value
        // here gets flagged by secret scanners forever, and the test only needs
        // a unique string to track through the document.
        const secret = 'ahai_7x2f_fake_fixture_key_not_a_secret';
        stubApi({
            keys: [],
            onWrite: () => json({
                ok: true,
                data: {
                    id: 'k9', name: 'Stream Deck', prefix: 'ahai_7x2f',
                    createdAt: '2026-08-17T10:00:00.000Z', lastUsedAt: null, key: secret
                }
            }, 201)
        });
        renderSettings();
        await openPane('Stream Deck');

        await userEvent.click(await screen.findByRole('button', { name: 'New key' }));
        await userEvent.type(screen.getByLabelText('Key name'), 'Stream Deck');
        await userEvent.click(screen.getByRole('button', { name: 'Make key' }));

        // Once.
        expect(await screen.findByText(secret)).toBeInTheDocument();
        expect(screen.getByText('Copy this now')).toBeInTheDocument();
        expect(screen.getByText(/only time you will see it/)).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: 'Done' }));

        // And never again, anywhere.
        await waitFor(() => { expect(screen.queryByText(secret)).not.toBeInTheDocument(); });
        expect(document.body.textContent).not.toContain(secret);

        // Re-opening the creation flow must not resurrect it either — the state
        // that held it is the modal's own and was cleared on the way out.
        await userEvent.click(screen.getByRole('button', { name: 'New key' }));
        expect(document.body.textContent).not.toContain(secret);
    });

    it('canceling the naming modal reveals nothing and sends nothing', async () => {
        const api = stubApi({ keys: [] });
        renderSettings();
        await openPane('Stream Deck');

        await userEvent.click(await screen.findByRole('button', { name: 'New key' }));
        await userEvent.type(screen.getByLabelText('Key name'), 'Stream Deck');
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(screen.queryByText('Copy this now')).not.toBeInTheDocument();
        expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('refuses an unnamed key, which would be unrevokable in practice', async () => {
        // The name is the only thing that identifies a key afterwards, because the
        // key itself is never shown again.
        const api = stubApi({ keys: [] });
        renderSettings();
        await openPane('Stream Deck');

        await userEvent.click(await screen.findByRole('button', { name: 'New key' }));
        await userEvent.click(screen.getByRole('button', { name: 'Make key' }));

        expect(await screen.findByText('Give the key a name so you can tell it apart later'))
            .toBeInTheDocument();
        expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('revokes optimistically', async () => {
        const api = stubApi({ keys: [key()], onWrite: () => new Response(null, { status: 204 }) });
        renderSettings();
        await openPane('Stream Deck');

        await userEvent.click(await screen.findByRole('button', { name: 'Revoke Backup deck' }));

        await waitFor(() => { expect(screen.queryByText('ahai_7x2f…')).not.toBeInTheDocument(); });
        expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true);
    });
});

// ---- 5c --------------------------------------------------------------------

describe('Settings · Account (5c)', () => {
    it('shows the identity, the running version, and sign out', async () => {
        stubApi();
        renderSettings();
        await openPane('Account');

        expect(await screen.findByText('almosthad')).toBeInTheDocument();
        // Read from the build rather than typed in a component, so a released
        // build cannot report a version that never existed.
        expect(screen.getByText(`Version ${APP_VERSION_NUMBER}`)).toBeInTheDocument();
        // Not "Version v0.1.0": the row supplies the word, so the number must not
        // also supply the letter.
        expect(screen.queryByText(/Version v/)).not.toBeInTheDocument();
        expect(screen.getByText('CURRENT')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    });

    it('spells out the consequences before the button, not after the decision', async () => {
        stubApi();
        renderSettings();
        await openPane('Account');

        // "Switched off", not "go away": the rewards are disabled and never
        // deleted, so the card must not imply the streamer loses their settings.
        expect(screen.queryByText(/rewards go away/)).not.toBeInTheDocument();
        expect(await screen.findByText(/three channel-point rewards are switched off/))
            .toBeInTheDocument();
        expect(screen.getByText(/commands, emotes and quotes stay put/)).toBeInTheDocument();
    });

    it('requires a second, differently-worded click to disconnect', async () => {
        /*
         * Not a modal, deliberately. A dialog for this is dismissible by every
         * reflex a person has for dismissing dialogs; a button that has changed
         * its own label to "Yes, disconnect" cannot be agreed with by accident.
         */
        const onDisconnectChannel = vi.fn(async () => null);
        stubApi();
        renderSettings({ onDisconnectChannel });
        await openPane('Account');

        await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
        expect(onDisconnectChannel).not.toHaveBeenCalled();
        expect(await screen.findByText(/This cannot be undone from here/)).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
        expect(onDisconnectChannel).toHaveBeenCalledTimes(1);
    });

    it('lets the confirmation be backed out of', async () => {
        const onDisconnectChannel = vi.fn(async () => null);
        stubApi();
        renderSettings({ onDisconnectChannel });
        await openPane('Account');

        await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
        expect(onDisconnectChannel).not.toHaveBeenCalled();
    });

    it('reports a failed disconnect rather than pretending it worked', async () => {
        stubApi();
        renderSettings({ onDisconnectChannel: async () => 'We cannot reach our server' });
        await openPane('Account');

        await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
        await userEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }));

        expect(await screen.findByText('We cannot reach our server')).toBeInTheDocument();
    });

    it('cannot be disconnected twice', async () => {
        stubApi();
        renderSettings({ channel: channel({ status: 'disconnected' }) });
        await openPane('Account');

        expect(await screen.findByText('Channel disconnected')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Disconnected' })).toBeDisabled();
    });

    it('has no destructive action other than disconnect', async () => {
        // Skip (on the songs screen) and disconnect are the two. Nothing here
        // deletes content, and the danger card is the only one with a danger
        // button in it.
        stubApi();
        renderSettings();
        await openPane('Account');

        await screen.findByText('almosthad');
        const danger = document.querySelectorAll('.button--danger');
        expect(danger).toHaveLength(1);
        expect(danger[0]?.textContent).toBe('Disconnect');
    });
});
