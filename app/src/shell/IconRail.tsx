import { useState } from 'react';
import {
    Gauge,
    Terminal,
    Smile,
    Quote,
    Music,
    BarChart3,
    Settings,
    type LucideIcon
} from 'lucide-react';

/**
 * The persistent navigation rail.
 *
 * Order and icons are fixed by the handoff. Labels are not rendered inline —
 * they appear on hover as a tooltip to the right, which is what keeps the rail
 * 64px wide while remaining usable by someone who has not memorised six
 * glyphs.
 */

export type RailSection =
    | 'dashboard'
    | 'commands'
    | 'emotes'
    | 'quotes'
    | 'songs'
    | 'analytics'
    | 'settings';

interface RailEntry {
    id: RailSection;
    label: string;
    Icon: LucideIcon;
}

const PRIMARY: RailEntry[] = [
    { id: 'dashboard', label: 'Dashboard', Icon: Gauge },
    { id: 'commands', label: 'Commands', Icon: Terminal },
    { id: 'emotes', label: 'Emotes', Icon: Smile },
    { id: 'quotes', label: 'Quotes', Icon: Quote },
    { id: 'songs', label: 'Songs', Icon: Music },
    { id: 'analytics', label: 'Analytics', Icon: BarChart3 }
];

const SETTINGS: RailEntry = { id: 'settings', label: 'Settings', Icon: Settings };

export interface IconRailProps {
    active: RailSection;
    onSelect: (section: RailSection) => void;
}

export function IconRail({ active, onSelect }: IconRailProps): React.JSX.Element {
    const [hovered, setHovered] = useState<RailSection | null>(null);

    const item = (entry: RailEntry): React.JSX.Element => {
        const isActive = entry.id === active;
        return (
            <button
                key={entry.id}
                type="button"
                className={`rail__item${isActive ? ' rail__item--active' : ''}`}
                aria-label={entry.label}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => { onSelect(entry.id); }}
                onMouseEnter={() => { setHovered(entry.id); }}
                onMouseLeave={() => { setHovered(null); }}
                onFocus={() => { setHovered(entry.id); }}
                onBlur={() => { setHovered(null); }}
            >
                <entry.Icon size={19} />
                {hovered === entry.id && (
                    <span className="rail__tooltip" role="tooltip">{entry.label}</span>
                )}
            </button>
        );
    };

    return (
        <nav className="rail" aria-label="Sections">
            {PRIMARY.map(item)}
            <div className="rail__spacer" />
            {item(SETTINGS)}
            <div className="rail__avatar" aria-hidden="true" />
        </nav>
    );
}
