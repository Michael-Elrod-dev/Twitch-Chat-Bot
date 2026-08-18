import { Minus, Plus } from 'lucide-react';

/**
 * A minus, a number and a plus, for the per-tier AI limits.
 *
 * The bounds are NOT written here. They are read off the contract's own schema
 * by `validation.ts`, which is the same rule the command form follows and for
 * the same reason: a maximum typed into a component is a second copy of a limit
 * that already exists, and the copy is the one that stays at the old number.
 *
 * The buttons disable at the ends rather than clamping silently. A `+` that
 * still looks pressable at the ceiling invites the streamer to press it and
 * wonder what broke.
 */

export interface StepperProps {
    value: number;
    min: number;
    max: number;
    /** What a reader hears, such as "Everyone" or "Mods". The row carries the visible one. */
    label: string;
    onChange: (next: number) => void;
    disabled?: boolean;
}

export function Stepper({
    value,
    min,
    max,
    label,
    onChange,
    disabled = false
}: StepperProps): React.JSX.Element {
    return (
        <span className="stepper">
            <button
                type="button"
                className="stepper__button"
                aria-label={`Fewer for ${label}`}
                disabled={disabled || value <= min}
                onClick={() => { onChange(value - 1); }}
            >
                <Minus size={13} />
            </button>
            {/*
              * Read as one value with its label, not as a bare number floating
              * between two buttons: "Everyone, 3" is what a reader should hear.
              */}
            <span className="stepper__value" aria-label={`${label}, ${value}`}>{value}</span>
            <button
                type="button"
                className="stepper__button"
                aria-label={`More for ${label}`}
                disabled={disabled || value >= max}
                onClick={() => { onChange(value + 1); }}
            >
                <Plus size={13} />
            </button>
        </span>
    );
}
