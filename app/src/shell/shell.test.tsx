import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelSummary } from '@almosthadai/shared';
import { TitleBar } from './TitleBar.js';
import { IconRail } from './IconRail.js';
import { ChannelHeader } from './ChannelHeader.js';
import { MasterSwitch } from './MasterSwitch.js';
import { APP_NAME } from '../theme/tokens.js';

const channel = (over: Partial<ChannelSummary> = {}): ChannelSummary => ({
    id: 'c1',
    login: 'streamer',
    displayName: null,
    status: 'active',
    enabled: true,
    ...over
});

describe('TitleBar', () => {
    const controls = () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() });

    it('shows the product name from the one constant', () => {
        render(<TitleBar controls={controls()} />);
        expect(screen.getByText(APP_NAME)).toBeInTheDocument();
    });

    it('drives the real window controls', async () => {
        const c = controls();
        render(<TitleBar controls={c} />);

        await userEvent.click(screen.getByRole('button', { name: 'Minimize' }));
        await userEvent.click(screen.getByRole('button', { name: 'Maximize' }));
        await userEvent.click(screen.getByRole('button', { name: 'Close' }));

        expect(c.minimize).toHaveBeenCalledOnce();
        expect(c.toggleMaximize).toHaveBeenCalledOnce();
        expect(c.close).toHaveBeenCalledOnce();
    });
});

describe('IconRail', () => {
    it('renders every section in the handoff order', () => {
        render(<IconRail active="dashboard" onSelect={vi.fn()} />);

        const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
        expect(labels).toEqual([
            'Dashboard', 'Commands', 'Emotes', 'Quotes', 'Songs', 'Analytics', 'Settings'
        ]);
    });

    it('marks exactly one item active', () => {
        render(<IconRail active="quotes" onSelect={vi.fn()} />);

        expect(screen.getByRole('button', { name: 'Quotes' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Songs' })).not.toHaveAttribute('aria-current');
    });

    it('shows the label on hover and hides it again', async () => {
        render(<IconRail active="dashboard" onSelect={vi.fn()} />);
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

        await userEvent.hover(screen.getByRole('button', { name: 'Commands' }));
        expect(screen.getByRole('tooltip')).toHaveTextContent('Commands');

        await userEvent.unhover(screen.getByRole('button', { name: 'Commands' }));
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('shows the label on keyboard focus too', async () => {
        render(<IconRail active="dashboard" onSelect={vi.fn()} />);

        await userEvent.tab();
        await userEvent.tab();
        expect(screen.getByRole('tooltip')).toHaveTextContent('Commands');
    });

    it('selects a section', async () => {
        const onSelect = vi.fn();
        render(<IconRail active="dashboard" onSelect={onSelect} />);

        await userEvent.click(screen.getByRole('button', { name: 'Analytics' }));
        expect(onSelect).toHaveBeenCalledWith('analytics');
    });
});

describe('MasterSwitch', () => {
    it('reports its state to assistive technology', () => {
        render(<MasterSwitch enabled operable onChange={vi.fn()} />);
        expect(screen.getByRole('switch')).toBeChecked();
    });

    it('flips to the opposite of its current value', async () => {
        const onChange = vi.fn();
        render(<MasterSwitch enabled operable onChange={onChange} />);

        await userEvent.click(screen.getByRole('switch'));
        expect(onChange).toHaveBeenCalledWith(false);
    });

    it('cannot be operated while inert', async () => {
        const onChange = vi.fn();
        render(<MasterSwitch enabled operable={false} onChange={onChange} />);

        await userEvent.click(screen.getByRole('switch'));
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole('switch')).toBeDisabled();
    });

    it('cannot be double-flipped while a flip is in flight', async () => {
        const onChange = vi.fn();
        render(<MasterSwitch enabled operable onChange={onChange} pending />);

        await userEvent.click(screen.getByRole('switch'));
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe('ChannelHeader', () => {
    const props = {
        connection: 'open' as const,
        live: false,
        onToggleBot: vi.fn()
    };

    it('names the channel', () => {
        render(<ChannelHeader {...props} channel={channel()} />);
        expect(screen.getByText('streamer')).toBeInTheDocument();
    });

    it('shows LIVE with the uptime', () => {
        render(<ChannelHeader {...props} channel={channel()} live uptime="2:14:07" />);
        expect(screen.getByText(/LIVE 2:14:07/)).toBeInTheDocument();
    });

    it('shows OFFLINE when the channel is not live', () => {
        render(<ChannelHeader {...props} channel={channel()} />);
        expect(screen.getByText('OFFLINE')).toBeInTheDocument();
    });

    it('shows NEEDS RECONNECT when Twitch has revoked consent', () => {
        render(<ChannelHeader {...props} channel={channel({ status: 'needs_reauth' })} />);
        expect(screen.getByText('NEEDS RECONNECT')).toBeInTheDocument();
    });

    it('shows UNKNOWN — not OFFLINE — when the server is unreachable', () => {
        render(<ChannelHeader {...props} channel={channel()} connection="down" />);

        expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
        expect(screen.queryByText('OFFLINE')).not.toBeInTheDocument();
    });

    it('renders the switch inert when the server is unreachable', () => {
        render(<ChannelHeader {...props} channel={channel()} connection="down" />);
        expect(screen.getByRole('switch')).toBeDisabled();
    });

    it('renders the switch inert when Twitch has revoked consent', () => {
        render(<ChannelHeader {...props} channel={channel({ status: 'needs_reauth' })} />);
        expect(screen.getByRole('switch')).toBeDisabled();
    });

    it('shows the switch off when the owner has switched the bot off', () => {
        render(<ChannelHeader {...props} channel={channel({ enabled: false })} />);

        expect(screen.getByRole('switch')).not.toBeChecked();
        // And the channel is still active — the two are reported separately.
        expect(screen.getByText('OFFLINE')).toBeInTheDocument();
    });

    it('reports a switched-off bot on a live channel without contradiction', () => {
        // `enabled` is the owner's choice and `status`/`live` is the world's
        // state; the header must be able to say "streaming, bot paused".
        render(<ChannelHeader {...props} channel={channel({ enabled: false })} live uptime="0:03:00" />);

        expect(screen.getByText(/LIVE/)).toBeInTheDocument();
        expect(screen.getByRole('switch')).not.toBeChecked();
    });
});
