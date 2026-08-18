import { describe, it, expect } from 'vitest';
import type { ChannelSummary } from '@almosthadai/shared';
import type { ConnectionState } from '../live/connection.js';
import { formatUptime, isMasterSwitchOperable, resolvePillState } from './channelStatus.js';

/**
 * The `4b` rule, in test form.
 *
 * "Server unreachable" and "bot offline" must never be conflated. These are the
 * assertions that would fail the moment someone made the reasonable-looking
 * simplification of treating a dropped socket as an offline channel.
 */

const channel = (status: ChannelSummary['status']): Pick<ChannelSummary, 'status'> => ({ status });

const states: ConnectionState[] = ['connecting', 'reconnecting', 'down'];

describe('resolvePillState', () => {
    it('reports LIVE only when the connection is open and the channel is live', () => {
        expect(resolvePillState({ connection: 'open', channel: channel('active'), live: true }))
            .toBe('live');
    });

    it('reports OFFLINE when the connection is open and the channel is not live', () => {
        expect(resolvePillState({ connection: 'open', channel: channel('active'), live: false }))
            .toBe('offline');
    });

    it.each(states)('reports UNKNOWN, never OFFLINE, while the connection is %s', (connection) => {
        // The channel is genuinely offline here and it still must not say so,
        // because there is no current information either way.
        expect(resolvePillState({ connection, channel: channel('active'), live: false }))
            .toBe('unknown');
    });

    it.each(states)('reports UNKNOWN, not LIVE, while the connection is %s', (connection) => {
        expect(resolvePillState({ connection, channel: channel('active'), live: true }))
            .toBe('unknown');
    });

    it('reports NEEDS RECONNECT over live', () => {
        // A revoked channel that happens to be streaming must show the thing
        // the user has to act on, not the thing they already know.
        expect(resolvePillState({ connection: 'open', channel: channel('needs_reauth'), live: true }))
            .toBe('needs_reauth');
    });

    it('reports UNKNOWN when no channel is connected', () => {
        expect(resolvePillState({ connection: 'open', channel: null, live: false }))
            .toBe('unknown');
    });
});

describe('isMasterSwitchOperable', () => {
    it('is operable on an open connection to an active channel', () => {
        expect(isMasterSwitchOperable({ connection: 'open', channel: channel('active'), live: false }))
            .toBe(true);
    });

    it.each(states)('is inert while the connection is %s', (connection) => {
        expect(isMasterSwitchOperable({ connection, channel: channel('active'), live: false }))
            .toBe(false);
    });

    it('is inert when Twitch has revoked consent', () => {
        expect(isMasterSwitchOperable({ connection: 'open', channel: channel('needs_reauth'), live: false }))
            .toBe(false);
    });
});

describe('formatUptime', () => {
    const at = (iso: string): Date => new Date(iso);

    it('formats hours, minutes and seconds', () => {
        expect(formatUptime(at('2026-08-16T10:00:00Z'), at('2026-08-16T12:14:07Z')))
            .toBe('2:14:07');
    });

    it('pads minutes and seconds but not hours', () => {
        expect(formatUptime(at('2026-08-16T10:00:00Z'), at('2026-08-16T10:05:09Z')))
            .toBe('0:05:09');
    });

    it('does not go negative when clocks disagree', () => {
        // A local clock ahead of the server's would otherwise render as a
        // count-up from a negative number.
        expect(formatUptime(at('2026-08-16T12:00:00Z'), at('2026-08-16T11:59:00Z')))
            .toBe('0:00:00');
    });
});
