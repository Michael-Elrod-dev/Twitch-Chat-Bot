import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Lock, Pencil, Search, Trash2 } from 'lucide-react';
import type { Command, UserLevel } from '@almosthadai/shared';
import type { SessionStorage } from '../auth/sessionStore.js';
import { useCollection, jsonRequest } from './useCollection.js';
import { describeHandler, USER_LEVEL_LABELS } from './commandCatalog.js';
import { CommandEditor } from './CommandEditor.js';
import { ContentBanner } from './ContentBanner.js';

/**
 * Commands (`2c`), its empty state (`4d`) and its editor (`4e`).
 *
 * The screen's one structural idea is that **handler-backed rows are not
 * editable, and look it**. A built-in has no `responseText` to change and no
 * route that would accept one, so the row shows what it does, a lock where the
 * actions would be, and no hover affordance at all. Rendering a disabled pencil
 * would imply a permission problem; there is no permission involved, the thing
 * simply is not that kind of command.
 */

const PAGE_SIZE = 10;

export type CommandFilter = 'all' | 'yours' | 'built-in';

/** Yours = you wrote the text. Built in = a handler answers it. */
export function isBuiltIn(command: Command): boolean {
    return command.handlerName !== null;
}

/**
 * Filter, then search — order matters only for readability, but the search
 * matching both name and reply is deliberate: people look for "the one about
 * the discord link" as often as they look for `!discord`.
 */
export function filterCommands(
    commands: Command[],
    filter: CommandFilter,
    search: string
): Command[] {
    const term = search.trim().toLowerCase();

    return commands.filter((command) => {
        if (filter === 'yours' && isBuiltIn(command)) return false;
        if (filter === 'built-in' && !isBuiltIn(command)) return false;
        if (term === '') return true;

        const haystack = isBuiltIn(command)
            ? `${command.name} ${describeHandler(command)}`
            : `${command.name} ${command.responseText ?? ''}`;
        return haystack.toLowerCase().includes(term);
    });
}

export interface CommandsProps {
    storage: SessionStorage;
}

export function Commands({ storage }: CommandsProps): React.JSX.Element {
    // Every command is fetched once and paged in memory: the whole list is 22
    // rows for the owner and the filter chips have to count across all of it
    // anyway ("5 yours · 17 built in" is a fact about the set, not the page).
    const collection = useCollection<Command>({ path: '/api/v1/commands', storage, limit: 200 });

    const [filter, setFilter] = useState<CommandFilter>('all');
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(0);
    const [editing, setEditing] = useState<Command | null | 'new'>(null);
    const [nameError, setNameError] = useState<string | null>(null);
    const [inlineNotice, setInlineNotice] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const yours = collection.items.filter((c) => !isBuiltIn(c));
    const builtIns = collection.items.filter(isBuiltIn);

    const visible = useMemo(
        () => filterCommands(collection.items, filter, search),
        [collection.items, filter, search]
    );

    const pageStart = Math.min(page * PAGE_SIZE, Math.max(0, visible.length - 1));
    const pageItems = visible.slice(pageStart, pageStart + PAGE_SIZE);
    const lastPage = Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1);

    const closeEditor = (): void => {
        setEditing(null);
        setNameError(null);
        setInlineNotice(null);
    };

    const save = (input: { name: string; responseText: string; userLevel: UserLevel }): void => {
        const existing = editing === 'new' ? null : editing;
        setNameError(null);
        setInlineNotice(null);
        setSaving(true);

        void (async () => {
            const error = existing === null
                ? await collection.mutate(
                    (current) => [...current, { ...input, handlerName: null, description: null }],
                    jsonRequest('/api/v1/commands', { method: 'POST', body: input }),
                    { totalDelta: 1 }
                )
                : await collection.mutate(
                    (current) => current.map((c) => (c.name === existing.name
                        ? { ...c, responseText: input.responseText, userLevel: input.userLevel }
                        : c)),
                    jsonRequest(`/api/v1/commands/${encodeURIComponent(existing.name)}`, {
                        method: 'PATCH',
                        body: { responseText: input.responseText, userLevel: input.userLevel }
                    })
                );

            setSaving(false);
            if (error === null) { closeEditor(); return; }

            // A conflict is a fact about the name, so it goes beside the name.
            if (error.placement === 'field') setNameError(error.message);
            if (error.placement === 'inline') setInlineNotice(error.message);
            // Banner-placed errors are already on the collection's banner.
        })();
    };

    const remove = (command: Command): void => {
        void collection.mutate(
            (current) => current.filter((c) => c.name !== command.name),
            jsonRequest(`/api/v1/commands/${encodeURIComponent(command.name)}`, { method: 'DELETE' }),
            { totalDelta: -1, treatGoneAsDone: true }
        );
    };

    /*
     * The empty state answers "you have not written any yet", so it must not
     * appear over a deliberate request to see the built-ins. A broadcaster who
     * has written none and clicks "Built in" is asking for a list, and showing
     * them a card that says they have nothing would be answering a question
     * they did not ask.
     */
    const isEmpty = !collection.loading && yours.length === 0 && filter !== 'built-in';

    return (
        <div className="content-page">
            <header className="content-header">
                <h1 className="content-title">Commands</h1>
                <span className="content-meta">
                    {yours.length} yours · {builtIns.length} built in
                </span>

                <div className="content-header__spacer" />

                <label className="search">
                    <Search size={14} aria-hidden="true" />
                    <input
                        className="search__input"
                        placeholder="Search"
                        aria-label="Search commands"
                        value={search}
                        onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                    />
                </label>

                <button
                    type="button"
                    className="button button--primary"
                    onClick={() => { setEditing('new'); }}
                >
                    New command
                </button>
            </header>

            <div className="chip-row">
                {(['all', 'yours', 'built-in'] as const).map((option) => (
                    <button
                        key={option}
                        type="button"
                        aria-pressed={filter === option}
                        className={`filter-chip${filter === option ? ' filter-chip--on' : ''}`}
                        onClick={() => { setFilter(option); setPage(0); }}
                    >
                        {option === 'all' ? 'All' : option === 'yours' ? 'Yours' : 'Built in'}
                    </button>
                ))}
            </div>

            {collection.banner && (
                <ContentBanner message={collection.banner} onDismiss={collection.dismissBanner} />
            )}

            {isEmpty
                ? <CommandsEmpty builtIns={builtIns} onWrite={() => { setEditing('new'); }} />
                : (
                    <section className="card list-card">
                        <div className="list-grid list-grid--commands list-grid__head">
                            <span>NAME</span>
                            <span>REPLY</span>
                            <span>WHO</span>
                            <span />
                        </div>

                        {pageItems.map((command) => (
                            <CommandRow
                                key={command.name}
                                command={command}
                                onEdit={() => { setEditing(command); }}
                                onDelete={() => { remove(command); }}
                            />
                        ))}

                        <div className="list-footer">
                            <span className="list-footer__count">
                                {visible.length === 0
                                    ? '0 of 0'
                                    : `${pageStart + 1}–${Math.min(pageStart + PAGE_SIZE, visible.length)} of ${visible.length}`}
                            </span>
                            <span className="list-footer__pager">
                                <button
                                    type="button"
                                    aria-label="Previous page"
                                    disabled={page === 0}
                                    onClick={() => { setPage((p) => Math.max(0, p - 1)); }}
                                >
                                    <ChevronLeft size={16} />
                                </button>
                                <button
                                    type="button"
                                    aria-label="Next page"
                                    disabled={page >= lastPage}
                                    onClick={() => { setPage((p) => Math.min(lastPage, p + 1)); }}
                                >
                                    <ChevronRight size={16} />
                                </button>
                            </span>
                        </div>
                    </section>
                )}

            {editing !== null && (
                <CommandEditor
                    editing={editing === 'new' ? null : editing}
                    nameError={nameError}
                    inlineNotice={inlineNotice}
                    saving={saving}
                    onCancel={closeEditor}
                    onSave={save}
                />
            )}
        </div>
    );
}

function CommandRow({ command, onEdit, onDelete }: {
    command: Command;
    onEdit: () => void;
    onDelete: () => void;
}): React.JSX.Element {
    if (isBuiltIn(command)) {
        return (
            <div className="list-grid list-grid--commands list-row list-row--builtin">
                <span className="list-row__name list-row__name--builtin">
                    {command.name}
                    <span className="chip chip--builtin">BUILT IN</span>
                </span>
                {/* The behaviour, not a reply: there is no stored text to show. */}
                <span className="list-row__behaviour">{describeHandler(command)}</span>
                <span className={`list-row__who${command.userLevel === 'mod' ? ' list-row__who--mod' : ''}`}>
                    {USER_LEVEL_LABELS[command.userLevel]}
                </span>
                <span className="list-row__actions">
                    {/* A lock, not a disabled pencil: nothing here is forbidden,
                        this is simply not a command with text to edit. */}
                    <Lock size={14} aria-label="Built in, not editable" />
                </span>
            </div>
        );
    }

    return (
        <div className="list-grid list-grid--commands list-row">
            <span className="list-row__name">{command.name}</span>
            <span className="list-row__reply">{command.responseText}</span>
            <span className={`list-row__who${command.userLevel === 'mod' ? ' list-row__who--mod' : ''}`}>
                {USER_LEVEL_LABELS[command.userLevel]}
            </span>
            <span className="list-row__actions list-row__actions--hover">
                <button type="button" aria-label={`Edit ${command.name}`} onClick={onEdit}>
                    <Pencil size={15} />
                </button>
                <button type="button" aria-label={`Delete ${command.name}`} onClick={onDelete}>
                    <Trash2 size={15} />
                </button>
            </span>
        </div>
    );
}

/** `4d` — nothing of your own yet, and the built-ins that already work. */
function CommandsEmpty({ builtIns, onWrite }: {
    builtIns: Command[];
    onWrite: () => void;
}): React.JSX.Element {
    return (
        <>
            <section className="card empty-card">
                <h2 className="empty-card__headline">You have not written any yet</h2>
                <p className="empty-card__copy">
                    A command is a word someone types in chat and a line the bot says back.
                </p>
                <div className="chip-row chip-row--centred">
                    {['!discord', '!socials', '!schedule'].map((suggestion) => (
                        <span className="suggestion-chip" key={suggestion}>{suggestion}</span>
                    ))}
                </div>
                <button type="button" className="button button--primary" onClick={onWrite}>
                    Write your first one
                </button>
            </section>

            <section className="card">
                <header className="card__header">
                    <h2 className="card__title">Already working, nothing to set up</h2>
                    <span className="card__meta">{builtIns.length}</span>
                </header>
                <div className="builtin-grid">
                    {builtIns.map((command) => (
                        <span className="builtin-chip" key={command.name}>{command.name}</span>
                    ))}
                </div>
            </section>
        </>
    );
}
