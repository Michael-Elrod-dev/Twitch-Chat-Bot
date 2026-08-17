import { useState } from 'react';
import { Shuffle, Trash2 } from 'lucide-react';
import type { Quote } from '@almosthadai/shared';
import { apiRequest } from '../api/client.js';
import { withFreshSession, type SessionStorage } from '../auth/sessionStore.js';
import { useCollection, jsonRequest } from './useCollection.js';
import { QUOTE_MAX_LENGTH, validateQuoteText } from './validation.js';
import { ContentBanner } from './ContentBanner.js';

/**
 * Quotes (`3b`).
 *
 * **Numbers are retired, not reused.** Deleting #7 leaves a hole where #7 was,
 * and the grid shows it. That is not an oversight to tidy up later — a quote
 * number is a permanent handle, printed in clip titles and typed into chat as
 * `!quote 7`, and renumbering would silently point every old reference at
 * someone else's words. The footnote says so out loud, because a user who sees
 * gaps and is not told will file it as a bug.
 */

export interface QuotesProps {
    storage: SessionStorage;
}

export function Quotes({ storage }: QuotesProps): React.JSX.Element {
    const collection = useCollection<Quote>({ path: '/api/v1/quotes', storage, limit: 200 });

    const [adding, setAdding] = useState(false);
    const [text, setText] = useState('');
    const [author, setAuthor] = useState('');
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [inlineNotice, setInlineNotice] = useState<string | null>(null);
    const [highlighted, setHighlighted] = useState<number | null>(null);

    const check = validateQuoteText(text);

    const submit = (): void => {
        setFieldError(null);
        setInlineNotice(null);
        if (!check.ok) { setFieldError(check.message); return; }

        const body = { quoteText: check.value, author: author.trim() === '' ? null : author.trim() };

        void (async () => {
            const error = await collection.mutate(
                // The number is the server's to assign, so the optimistic row
                // carries a placeholder that the reload replaces. Guessing
                // `max + 1` would be wrong the moment two quotes race.
                (current) => [...current, { quoteNumber: -1, ...body }],
                jsonRequest('/api/v1/quotes', { method: 'POST', body }),
                { totalDelta: 1 }
            );

            if (error === null) {
                setText(''); setAuthor(''); setAdding(false);
                // Re-read so the placeholder becomes the real number.
                await collection.reload();
                return;
            }
            if (error.placement === 'field') setFieldError(error.message);
            if (error.placement === 'inline') setInlineNotice(error.message);
        })();
    };

    const remove = (quote: Quote): void => {
        void collection.mutate(
            (current) => current.filter((q) => q.quoteNumber !== quote.quoteNumber),
            jsonRequest(`/api/v1/quotes/${quote.quoteNumber}`, { method: 'DELETE' }),
            { totalDelta: -1, treatGoneAsDone: true }
        );
    };

    const random = (): void => {
        void (async () => {
            try {
                const quote = await withFreshSession(storage, (accessToken) =>
                    apiRequest<Quote>('/api/v1/quotes/random', { accessToken }));
                setHighlighted(quote.quoteNumber);
            } catch {
                // A channel with no quotes answers 404. Nothing to highlight and
                // nothing worth alarming anyone about.
                setHighlighted(null);
            }
        })();
    };

    return (
        <div className="content-page">
            <header className="content-header">
                <h1 className="content-title">Quotes</h1>
                <span className="content-meta">{collection.total} saved</span>

                <div className="content-header__spacer" />

                <button type="button" className="button button--ghost" onClick={random}>
                    <Shuffle size={15} aria-hidden="true" />
                    Random
                </button>
                <button
                    type="button"
                    className="button button--primary"
                    onClick={() => { setAdding((v) => !v); }}
                >
                    Add quote
                </button>
            </header>

            {collection.banner && (
                <ContentBanner message={collection.banner} onDismiss={collection.dismissBanner} />
            )}

            {adding && (
                <section className="card quote-composer">
                    <label className="field">
                        <span className="field__label-row">
                            <span className="field__label">QUOTE</span>
                            <span className="field__counter">{text.trim().length} / {QUOTE_MAX_LENGTH}</span>
                        </span>
                        <textarea
                            className={`field__input field__textarea${fieldError ? ' field__input--invalid' : ''}`}
                            aria-label="Quote"
                            value={text}
                            onChange={(e) => { setText(e.target.value); }}
                        />
                    </label>
                    <label className="field">
                        <span className="field__label">WHO SAID IT (OPTIONAL)</span>
                        <input
                            className="field__input"
                            aria-label="Author"
                            value={author}
                            onChange={(e) => { setAuthor(e.target.value); }}
                        />
                    </label>
                    {fieldError && <span className="field__error">{fieldError}</span>}
                    {inlineNotice && <p className="inline-notice">{inlineNotice}</p>}
                    <div className="modal__actions">
                        <button type="button" className="button button--text" onClick={() => { setAdding(false); }}>
                            Cancel
                        </button>
                        <button type="button" className="button button--primary" onClick={submit}>
                            Save quote
                        </button>
                    </div>
                </section>
            )}

            <div className="quote-grid">
                {collection.items.map((quote) => (
                    <article
                        className={`card quote-card${highlighted === quote.quoteNumber ? ' quote-card--highlighted' : ''}`}
                        key={quote.quoteNumber}
                    >
                        <span className="quote-card__number">#{quote.quoteNumber}</span>
                        <span className="quote-card__body">
                            <span className="quote-card__text">{quote.quoteText}</span>
                            {quote.author && <span className="quote-card__author">— {quote.author}</span>}
                        </span>
                        <button
                            type="button"
                            className="quote-card__delete"
                            aria-label={`Delete quote ${quote.quoteNumber}`}
                            onClick={() => { remove(quote); }}
                        >
                            <Trash2 size={14} />
                        </button>
                    </article>
                ))}
            </div>

            <p className="footnote">
                Numbers stick — #7 stays #7 forever, so old clips never point at the wrong quote.
            </p>
        </div>
    );
}
