import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignIn } from './SignIn.js';
import { Waiting } from './Waiting.js';
import { Onboarding } from './Onboarding.js';
import { APP_VERSION } from '../api/config.js';

describe('SignIn (3g)', () => {
    it('offers the browser sign-in', async () => {
        const onSignIn = vi.fn();
        render(<SignIn onSignIn={onSignIn} serverReachable />);

        await userEvent.click(screen.getByRole('button', { name: /Continue with Twitch/ }));
        expect(onSignIn).toHaveBeenCalledOnce();
    });

    it('says plainly that the app never sees the password', () => {
        render(<SignIn onSignIn={vi.fn()} serverReachable />);
        expect(screen.getByText(/never sees your\s+password/)).toBeInTheDocument();
    });

    it('reports each reachability state without guessing', () => {
        const rows: { name: string; reachable: boolean | null; text: string }[] = [
            { name: 'reachable', reachable: true, text: 'SERVER REACHABLE' },
            { name: 'unreachable', reachable: false, text: 'SERVER UNREACHABLE' },
            { name: 'still checking', reachable: null, text: 'CHECKING' }
        ];

        for (const row of rows) {
            const { unmount } = render(<SignIn onSignIn={vi.fn()} serverReachable={row.reachable} />);

            expect(screen.getByText(row.text), row.name).toBeInTheDocument();
            unmount();
        }
    });

    it('surfaces an error without hiding the button', () => {
        render(<SignIn onSignIn={vi.fn()} serverReachable error="Something went wrong" />);

        expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
        expect(screen.getByRole('button', { name: /Continue with Twitch/ })).toBeEnabled();
    });

    it('pins the version', () => {
        render(<SignIn onSignIn={vi.fn()} serverReachable />);
        expect(screen.getByText(APP_VERSION)).toBeInTheDocument();
    });
});

describe('Waiting (5d)', () => {
    it('says what it is waiting for', () => {
        render(<Waiting onReopen={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.getByRole('status')).toHaveTextContent('Waiting for Twitch');
    });

    it('can reopen the tab', async () => {
        const onReopen = vi.fn();
        render(<Waiting onReopen={onReopen} onCancel={vi.fn()} />);

        await userEvent.click(screen.getByRole('button', { name: 'Open the tab again' }));
        expect(onReopen).toHaveBeenCalledOnce();
    });

    it('can be cancelled', async () => {
        const onCancel = vi.fn();
        render(<Waiting onReopen={vi.fn()} onCancel={onCancel} />);

        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('surfaces a rejected callback', () => {
        render(
            <Waiting
                onReopen={vi.fn()}
                onCancel={vi.fn()}
                error="Ignored a sign-in this app did not start."
            />
        );
        expect(screen.getByRole('alert')).toHaveTextContent('did not start');
    });
});

describe('Onboarding (3h)', () => {
    it('names the channel it is about to connect', () => {
        render(<Onboarding login="streamer" onConnect={vi.fn()} />);
        expect(screen.getByText('streamer')).toBeInTheDocument();
    });

    it('lists all five scopes in plain language', () => {
        render(<Onboarding login="streamer" onConnect={vi.fn()} />);

        expect(screen.getAllByRole('listitem')).toHaveLength(5);
        for (const name of ['Read chat', 'Send chat', 'Channel points', 'Stream status', 'Followers']) {
            expect(screen.getByText(name)).toBeInTheDocument();
        }
    });

    it('reassures that personal rewards are untouched', () => {
        render(<Onboarding login="streamer" onConnect={vi.fn()} />);
        expect(screen.getByText(/never touched/)).toBeInTheDocument();
    });

    it('connects the channel', async () => {
        const onConnect = vi.fn();
        render(<Onboarding login="streamer" onConnect={onConnect} />);

        await userEvent.click(screen.getByRole('button', { name: 'Connect my channel' }));
        expect(onConnect).toHaveBeenCalledOnce();
    });
});
