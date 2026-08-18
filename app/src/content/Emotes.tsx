import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { Emote } from '@almosthadai/shared';
import type { SessionStorage } from '../auth/sessionStore.js';
import { useCollection, jsonRequest } from './useCollection.js';
import { validateEmoteTrigger, validateReply } from './validation.js';
import { ContentBanner } from './ContentBanner.js';

/**
 * Emotes (`3a`).
 *
 * **The composer is the first row, not a modal.** That is the whole design of
 * this screen: adding an emote is a two-field, one-button act, and a dialog for
 * it would be ceremony around something you do five times in a row. It sits in
 * the grid so the thing you are about to make lines up with the things you have
 * already made.
 *
 * No edit path, deliberately. An emote is a trigger and a reply and nothing
 * else, editing one is indistinguishable from deleting it and adding another,
 * and the API agrees, because there is no PATCH route. Offering an edit
 * affordance would be inventing a capability.
 */

export interface EmotesProps {
    storage: SessionStorage;
}

export function Emotes({ storage }: EmotesProps): React.JSX.Element {
    const collection = useCollection<Emote>({ path: '/api/v1/emotes', storage, limit: 200 });

    const [trigger, setTrigger] = useState('');
    const [reply, setReply] = useState('');
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [inlineNotice, setInlineNotice] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);

    const add = (): void => {
        const triggerCheck = validateEmoteTrigger(trigger);
        const replyCheck = validateReply(reply);

        setFieldError(null);
        setInlineNotice(null);

        if (!triggerCheck.ok) { setFieldError(triggerCheck.message); return; }
        if (!replyCheck.ok) { setFieldError(replyCheck.message); return; }

        // The schema's normalized trigger, lowercased and trimmed, because
        // matching is exact and on the lowercased text. Submitting the raw
        // input would store a trigger chat could never hit.
        const body = { triggerText: triggerCheck.value, responseText: replyCheck.value };
        setAdding(true);

        void (async () => {
            const error = await collection.mutate(
                (current) => [...current, body],
                jsonRequest('/api/v1/emotes', { method: 'POST', body }),
                { totalDelta: 1 }
            );

            setAdding(false);
            if (error === null) { setTrigger(''); setReply(''); return; }
            if (error.placement === 'field') setFieldError(error.message);
            if (error.placement === 'inline') setInlineNotice(error.message);
        })();
    };

    const remove = (emote: Emote): void => {
        void collection.mutate(
            (current) => current.filter((e) => e.triggerText !== emote.triggerText),
            jsonRequest(`/api/v1/emotes/${encodeURIComponent(emote.triggerText)}`, { method: 'DELETE' }),
            { totalDelta: -1, treatGoneAsDone: true }
        );
    };

    return (
        <div className="content-page">
            <header className="content-header">
                <h1 className="content-title">Emotes</h1>
                <span className="content-meta">{collection.total} set up</span>
            </header>

            {collection.banner && (
                <ContentBanner message={collection.banner} onDismiss={collection.dismissBanner} />
            )}

            <section className="card list-card">
                <div className="list-grid list-grid--emotes list-grid__head">
                    <span>WHEN SOMEONE SAYS EXACTLY</span>
                    <span>BOT REPLIES</span>
                    <span />
                </div>

                {/* The composer, in the grid rather than over it. */}
                <div className="list-grid list-grid--emotes list-row list-row--composer">
                    <input
                        className={`field__input field__input--mono field__input--clay${fieldError ? ' field__input--invalid' : ''}`}
                        placeholder="trigger"
                        aria-label="Trigger"
                        value={trigger}
                        onChange={(e) => { setTrigger(e.target.value); }}
                    />
                    <input
                        className="field__input"
                        placeholder="what the bot says back"
                        aria-label="Reply"
                        value={reply}
                        onChange={(e) => { setReply(e.target.value); }}
                    />
                    <button
                        type="button"
                        className="button button--primary button--small"
                        disabled={adding}
                        onClick={add}
                    >
                        Add
                    </button>
                </div>

                {fieldError && <p className="list-row__error">{fieldError}</p>}
                {inlineNotice && <p className="inline-notice">{inlineNotice}</p>}

                {collection.items.map((emote) => (
                    <div className="list-grid list-grid--emotes list-row" key={emote.triggerText}>
                        <span className="list-row__name">{emote.triggerText}</span>
                        <span className="list-row__reply">{emote.responseText}</span>
                        <span className="list-row__actions">
                            <button
                                type="button"
                                aria-label={`Delete ${emote.triggerText}`}
                                onClick={() => { remove(emote); }}
                            >
                                <Trash2 size={15} />
                            </button>
                        </span>
                    </div>
                ))}
            </section>

            <p className="footnote">
                Exact match only. A message has to be just the trigger, nothing around it.
            </p>
        </div>
    );
}
