import { okGlowDelay, type StatusTile } from './dashboardState.js';

/**
 * Five tiles across the top of the dashboard.
 *
 * The dots are the whole point of this row. It is read at a glance from a
 * second monitor, and the words are confirmation rather than the message. The
 * healthy ones are staggered so the row shimmers instead of blinking in unison;
 * the `?` state is deliberately not a dot at all, because a grey dot would read
 * as "off" when what we mean is "we cannot see".
 */

export interface StatusStripProps {
    tiles: StatusTile[];
}

export function StatusStrip({ tiles }: StatusStripProps): React.JSX.Element {
    return (
        <div className="status-strip">
            {tiles.map((tile, index) => (
                <div className="status-tile" key={tile.id} data-tile={tile.id}>
                    <span className="status-tile__label">{tile.label}</span>
                    <span className="status-tile__reading">
                        {tile.dot === 'unknown'
                            ? <span className="status-tile__unknown" aria-hidden="true">?</span>
                            : (
                                <span
                                    className={`dot dot--${tile.dot}`}
                                    aria-hidden="true"
                                    // Only the animated state carries a delay; a
                                    // still dot with one would be inert anyway.
                                    style={tile.dot === 'healthy'
                                        ? { animationDelay: okGlowDelay(index) }
                                        : undefined}
                                />
                            )}
                        <span className="status-tile__value">{tile.value}</span>
                    </span>
                </div>
            ))}
        </div>
    );
}
