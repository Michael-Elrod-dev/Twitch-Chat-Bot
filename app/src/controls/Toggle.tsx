/**
 * The toggle, once.
 *
 * The header's master switch drew its own because it is fused to a pill that
 * carries a label and three inert states. Every other toggle in the app, meaning
 * the songs header and five setting rows, is this. Drawing them separately is how the
 * knob ends up 15px in one place and 14px in another.
 *
 * `role="switch"` rather than a checkbox: a screen reader should say "on/off",
 * not "checked", for a control whose whole meaning is a state the bot is in.
 */

export interface ToggleProps {
    on: boolean;
    /** What a reader hears. The visible label is the row's, not the control's. */
    label: string;
    onChange: (next: boolean) => void;
    /**
     * Rendered visibly dead rather than merely unresponsive.
     *
     * The songs header toggle is disabled when Spotify is absent, because a
     * switch that looks live but does nothing is worse than one that plainly
     * cannot be used. The streamer would flip it, see no change, and conclude
     * the bot is broken rather than that the account is unlinked.
     */
    disabled?: boolean;
}

export function Toggle({ on, label, onChange, disabled = false }: ToggleProps): React.JSX.Element {
    const className = disabled
        ? 'toggle toggle--inert'
        : on ? 'toggle toggle--on' : 'toggle';

    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            className={className}
            disabled={disabled}
            onClick={() => { onChange(!on); }}
        >
            <span className="toggle__knob" aria-hidden="true" />
        </button>
    );
}
