/**
 * The standard setting row: a title, an optional description, a control on the
 * right, and a hairline underneath unless it is the last one in its card.
 *
 * Written once because the handoff specifies it once — `16px 18px`, title
 * 13.5/600, description 12.5/1.5 capped at 430px. Five screens use it, and five
 * hand-built copies would be five chances for one of them to be 14px.
 *
 * The "no hairline after the last row" rule is CSS (`:last-child`), not a prop:
 * a component that had to be told it was last would be told wrong the first time
 * a row became conditional.
 */

export interface SettingRowProps {
    title: string;
    description?: string | undefined;
    /** The control, right-aligned. */
    children?: React.ReactNode;
    /** An extra line under the row — the sage save confirmation, an inline error. */
    footer?: React.ReactNode;
}

export function SettingRow({
    title,
    description,
    children,
    footer
}: SettingRowProps): React.JSX.Element {
    return (
        <div className="setting-row">
            <div className="setting-row__text">
                <span className="setting-row__title">{title}</span>
                {description && <p className="setting-row__description">{description}</p>}
                {footer}
            </div>
            {children && <div className="setting-row__control">{children}</div>}
        </div>
    );
}
