import type { NumberCard } from './dashboardState.js';

/**
 * Today's four figures.
 *
 * When the server is unreachable these become skeleton blocks rather than
 * zeroes or `?` figures at full size, which is the handoff's rule and the right
 * one. A `30px` zero is a confident statement, and the one thing this screen must
 * never do is state a number it does not have.
 */

export interface NumbersRowProps {
    cards: NumberCard[];
    /** True when we cannot see the server. Renders skeletons. */
    unknown: boolean;
    /** `Thursday, 4h 02m`, shown above the row when the channel is offline. */
    lastStreamCaption?: string | null;
}

export function NumbersRow({ cards, unknown, lastStreamCaption }: NumbersRowProps): React.JSX.Element {
    return (
        <div className="numbers">
            {lastStreamCaption && !unknown && (
                <div className="numbers__caption">
                    <span className="numbers__caption-label">Last stream</span>
                    <span className="numbers__caption-value">{lastStreamCaption}</span>
                </div>
            )}

            <div className="numbers__row">
                {cards.map((card) => (
                    <div className="number-card" key={card.id}>
                        {unknown
                            ? <span className="number-card__skeleton" aria-label="Unknown" role="img" />
                            : <span className="number-card__figure">{card.figure}</span>}
                        <span className="number-card__label">{card.label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
