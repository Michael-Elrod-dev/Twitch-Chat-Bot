import { useState } from 'react';
import type { Command, UserLevel } from '@almosthadai/shared';
import { USER_LEVEL_LABELS, USER_LEVEL_ORDER } from './commandCatalog.js';
import { REPLY_MAX_LENGTH, validateCommandName, validateReply } from './validation.js';

/**
 * The command editor.
 *
 * Validation is the schema's, not a copy of it, as `validation.ts` sets out.
 * What this component owns is where a verdict appears: the name's beside the name, the
 * reply's beside the reply, and a `conflict` from the server beside the name
 * too, because "that already exists" is a fact about the name and nowhere else.
 *
 * Editing an existing command deliberately cannot rename it. `updateCommandSchema`
 * accepts only `responseText` and `userLevel`, because the name is the identity
 * in the route path, so offering an editable name field would be offering
 * something the API cannot do.
 */

export interface CommandEditorProps {
    /** Null when writing a new one. */
    editing: Command | null;
    /** Field-level message from the server, e.g. a `conflict` on the name. */
    nameError?: string | null;
    /** The non-scary rate-limit line, if the last attempt was throttled. */
    inlineNotice?: string | null;
    saving?: boolean;
    onCancel: () => void;
    onSave: (input: { name: string; responseText: string; userLevel: UserLevel }) => void;
}

export function CommandEditor({
    editing,
    nameError = null,
    inlineNotice = null,
    saving = false,
    onCancel,
    onSave
}: CommandEditorProps): React.JSX.Element {
    const [name, setName] = useState(editing?.name ?? '');
    const [reply, setReply] = useState(editing?.responseText ?? '');
    const [level, setLevel] = useState<UserLevel>(editing?.userLevel ?? 'everyone');
    const [touched, setTouched] = useState(false);

    const nameCheck = validateCommandName(name);
    const replyCheck = validateReply(reply);
    const isNew = editing === null;

    // Only after a submit attempt: telling someone their half-typed name is
    // invalid while they are still typing it is nagging, not helping.
    const showNameError = touched && !nameCheck.ok;
    const showReplyError = touched && !replyCheck.ok;

    const submit = (): void => {
        setTouched(true);
        if (!nameCheck.ok || !replyCheck.ok) return;

        // The schema's normalized output, not the raw input: `!Foo` is stored
        // and matched as `!foo`, and submitting the raw text would save a name
        // chat could never trigger.
        onSave({ name: nameCheck.value, responseText: replyCheck.value, userLevel: level });
    };

    return (
        <div className="modal-scrim" role="presentation">
            <div className="modal" role="dialog" aria-modal="true" aria-label={isNew ? 'New command' : `Edit ${editing.name}`}>
                <h2 className="modal__title">{isNew ? 'New command' : 'Edit command'}</h2>

                <label className="field">
                    <span className="field__label">NAME</span>
                    <input
                        className={`field__input field__input--mono${showNameError || nameError ? ' field__input--invalid' : ''}`}
                        value={name}
                        // An existing command's name is its identity in the API
                        // path; there is no rename endpoint to back an edit.
                        disabled={!isNew}
                        placeholder="!discord"
                        onChange={(e) => { setName(e.target.value); }}
                    />
                    <span className="field__hint">
                        {showNameError
                            ? <span className="field__error">{nameCheck.message}</span>
                            : nameError
                                ? <span className="field__error">{nameError}</span>
                                : 'Starts with ! and no spaces.'}
                    </span>
                </label>

                <label className="field">
                    <span className="field__label-row">
                        <span className="field__label">REPLY</span>
                        <span className="field__counter">
                            {replyCheck.value.length} / {REPLY_MAX_LENGTH}
                        </span>
                    </span>
                    <textarea
                        className={`field__input field__textarea${showReplyError ? ' field__input--invalid' : ''}`}
                        value={reply}
                        onChange={(e) => { setReply(e.target.value); }}
                    />
                    {showReplyError && <span className="field__error">{replyCheck.message}</span>}
                </label>

                <div className="field">
                    <span className="field__label">WHO CAN USE IT</span>
                    <div className="chip-row" role="radiogroup" aria-label="Who can use it">
                        {USER_LEVEL_ORDER.map((option) => (
                            <button
                                key={option}
                                type="button"
                                role="radio"
                                aria-checked={level === option}
                                className={`select-chip${level === option ? ' select-chip--on' : ''}`}
                                onClick={() => { setLevel(option); }}
                            >
                                {USER_LEVEL_LABELS[option]}
                            </button>
                        ))}
                    </div>
                </div>

                {inlineNotice && <p className="inline-notice">{inlineNotice}</p>}

                <div className="modal__actions">
                    <button type="button" className="button button--text" onClick={onCancel}>Cancel</button>
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={saving}
                        onClick={submit}
                    >
                        Save command
                    </button>
                </div>
            </div>
        </div>
    );
}
