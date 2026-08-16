import type { ChannelSummary } from '@almosthadai/shared';
import type { ConnectionState } from '../live/connection.js';
import { StatusPill } from './StatusPill.js';
import { MasterSwitch } from './MasterSwitch.js';
import { isMasterSwitchOperable, resolvePillState } from './channelStatus.js';

/**
 * Who this app is looking at, and whether the bot is running in their channel.
 *
 * There is no channel selector anywhere in this app: the credential is the
 * tenant. The header names the channel because it is useful to see, not because
 * anything can be switched.
 */

export interface ChannelHeaderProps {
    channel: ChannelSummary | null;
    connection: ConnectionState;
    live: boolean;
    uptime?: string | undefined;
    onToggleBot: (next: boolean) => void;
    togglePending?: boolean;
}

export function ChannelHeader({
    channel,
    connection,
    live,
    uptime,
    onToggleBot,
    togglePending = false
}: ChannelHeaderProps): React.JSX.Element {
    const inputs = { connection, channel, live };

    return (
        <div className="channel-header">
            <div className="channel-header__identity">
                <span className="channel-header__avatar" aria-hidden="true" />
                <span className="channel-header__login">{channel?.login ?? '—'}</span>
                <StatusPill state={resolvePillState(inputs)} uptime={uptime} />
            </div>

            <MasterSwitch
                // Falls back to "on" only for rendering a channel we have not
                // loaded yet; the switch is inert in that case anyway, so it
                // cannot act on the guess.
                enabled={channel?.enabled ?? true}
                operable={isMasterSwitchOperable(inputs)}
                onChange={onToggleBot}
                pending={togglePending}
            />
        </div>
    );
}
