/**
 * The bot master switch.
 *
 * Optimistic with rollback: the toggle moves immediately because a control that
 * waits on a round trip feels broken, and it moves back if the server refuses.
 * Inert — visibly, not just unresponsively — when the server is unreachable or
 * Twitch has revoked consent, because a switch that looks live but does nothing
 * is worse than one that plainly cannot be used.
 */

export interface MasterSwitchProps {
    enabled: boolean;
    operable: boolean;
    onChange: (next: boolean) => void;
    /** Set while a flip is in flight, so a second click cannot race the first. */
    pending?: boolean;
}

export function MasterSwitch({
    enabled,
    operable,
    onChange,
    pending = false
}: MasterSwitchProps): React.JSX.Element {
    const label = operable ? (enabled ? 'Bot on' : 'Bot off') : 'Bot';

    const pillClass = !operable
        ? 'master-switch master-switch--inert'
        : enabled
            ? 'master-switch'
            : 'master-switch master-switch--off';

    const toggleClass = !operable
        ? 'toggle toggle--inert'
        : enabled
            ? 'toggle toggle--on'
            : 'toggle';

    return (
        <span className={pillClass}>
            {label}
            <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label="Bot on"
                className={toggleClass}
                disabled={!operable || pending}
                onClick={() => { onChange(!enabled); }}
            >
                <span className="toggle__knob" aria-hidden="true" />
            </button>
        </span>
    );
}
