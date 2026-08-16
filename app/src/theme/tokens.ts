/**
 * The design system, as constants.
 *
 * Every value here is taken from the design handoff README's token tables. This
 * module is the only place any of them are written down: components reference
 * CSS custom properties, and `applyTheme` is what turns these constants into
 * those properties. A colour that appears literally in a stylesheet is a bug —
 * it is a value that cannot be changed from one place.
 *
 * Scope is Windows desktop, dark theme only. Light theme and web layout were
 * explicitly deferred, so there is deliberately no second palette to keep in
 * step with this one.
 */

/**
 * The product name.
 *
 * ONE constant, everywhere — the mocks show the literal placeholder `APP NAME`
 * because the rebrand has not happened yet. The window title, the document
 * title and the title-bar wordmark all read this; nothing else names the app.
 */
export const APP_NAME = 'APP NAME';

export const colors = {
    /** Window body and content area. */
    appBackground: '#171614',
    /** Icon rail, chat sidecar, and inset surfaces inside cards. */
    railSurface: '#141312',
    titleBar: '#121110',
    cardSurface: '#1e1c1a',
    insetSurface: '#141312',

    hairline: 'rgba(240,235,225,.06)',
    /** Rail edge and header underline — one step stronger than a card border. */
    hairlineStructural: 'rgba(240,235,225,.07)',
    rowDivider: 'rgba(240,235,225,.04)',

    textPrimary: '#ece7df',
    textBody: '#c8c1b7',
    textSecondary: '#9c948a',
    textTertiary: '#6b645c',
    textFaint: '#57524b',
    textFaintest: '#514c46',

    disabled: '#413c37',
    disabledIcon: '#4f4a44',

    /**
     * Clay. Also the warning and danger colour — there is deliberately no
     * separate error red in this system.
     */
    accent: '#c8663f',
    accentHover: '#e0805a',
    accentTint: 'rgba(200,102,63,.13)',
    accentTintStrong: 'rgba(200,102,63,.14)',
    accentBorder: 'rgba(200,102,63,.35)',
    accentBorderSoft: 'rgba(200,102,63,.4)',
    /** Text and icons sitting ON a clay button. */
    onAccent: '#1a1512',

    /** Sage. Healthy dots, toggle-on track. */
    success: '#7f9c6e',
    successText: '#9dbd8c',
    successTint: 'rgba(127,156,110,.13)',

    /** Toggle-off track and knob, tooltip surface. */
    toggleOffTrack: '#332f2b',
    toggleOffKnob: '#5a544d',
    tooltipSurface: '#2a2724',
    tooltipBorder: 'rgba(240,235,225,.09)',

    borderSubtle: 'rgba(240,235,225,.08)',
    borderMuted: 'rgba(240,235,225,.09)',
    borderStrong: 'rgba(240,235,225,.1)',

    modalScrim: 'rgba(12,11,10,.62)',

    /** Every avatar and album-art square until a real image loads. */
    placeholderStripe:
        'repeating-linear-gradient(135deg,#33302c,#33302c 3px,#2a2724 3px,#2a2724 6px)'
} as const;

export const fonts = {
    /** All UI text. */
    sans: '"Instrument Sans", system-ui, sans-serif',
    /** Anything the machine owns: numbers, logins, command names, timestamps. */
    mono: '"JetBrains Mono", ui-monospace, monospace'
} as const;

/** Role → the exact type spec from the handoff's typography table. */
export const type = {
    pageTitle: { family: fonts.sans, weight: 600, size: '22px', lineHeight: '1', letterSpacing: '-.01em' },
    bigFigure: { family: fonts.mono, weight: 600, size: '30px', lineHeight: '1', letterSpacing: '-.02em' },
    cardTitle: { family: fonts.sans, weight: 600, size: '13px', lineHeight: '1', letterSpacing: 'normal' },
    settingRowTitle: { family: fonts.sans, weight: 600, size: '13.5px', lineHeight: '1', letterSpacing: 'normal' },
    body: { family: fonts.sans, weight: 400, size: '13.5px', lineHeight: '1.6', letterSpacing: 'normal' },
    tableCell: { family: fonts.sans, weight: 400, size: '13px', lineHeight: '1.4', letterSpacing: 'normal' },
    microLabel: { family: fonts.mono, weight: 500, size: '10px', lineHeight: '1', letterSpacing: '.1em' },
    statusPill: { family: fonts.mono, weight: 600, size: '11px', lineHeight: '1', letterSpacing: '.06em' },
    outcomeChip: { family: fonts.mono, weight: 600, size: '9.5px', lineHeight: '1', letterSpacing: '.08em' },
    buttonLabel: { family: fonts.sans, weight: 600, size: '12.5px', lineHeight: '1', letterSpacing: 'normal' },
    emptyHeadline: { family: fonts.sans, weight: 600, size: '19px', lineHeight: '1.3', letterSpacing: '-.015em' },
    metaMono: { family: fonts.mono, weight: 400, size: '11px', lineHeight: '1', letterSpacing: 'normal' },
    wordmark: { family: fonts.mono, weight: 500, size: '11px', lineHeight: '1', letterSpacing: '.08em' }
} as const;

export const space = {
    titleBarHeight: '36px',
    railWidth: '64px',
    channelHeaderHeight: '66px',

    pagePadding: '26px 28px',
    dashboardPadding: '24px 28px',
    cardPadding: '18px',
    cardHeaderPadding: '13px 18px',
    rowPadding: '13px 18px',

    /** Between sibling cards in a grid. */
    gridGap: '12px',
    /** Between major regions. */
    regionGap: '16px',
    /** Between page sections. */
    sectionGap: '20px',
    chipGap: '6px'
} as const;

export const radius = {
    card: '10px',
    control: '9px',
    chip: '8px',
    modal: '14px',
    pill: '999px',
    railItem: '10px',
    avatarSmall: '9px',
    avatarLarge: '12px',
    tooltip: '7px',
    wordmarkTile: '3px'
} as const;

/**
 * The two keyframes this system has, and nothing else.
 *
 * Healthy dots stagger across the status row so it shimmers rather than blinks
 * in unison; offline is the same dot at reduced opacity with no animation —
 * on, but not busy.
 */
export const motion = {
    okGlowDuration: '3.4s',
    liveGlowDuration: '2.6s',
    /** Applied in order across the five status tiles. */
    okGlowStagger: ['0s', '.45s', '.9s', '1.35s'],
    offlineDotOpacity: '.55',
    easing: 'ease-in-out'
} as const;

export type ThemeTokens = {
    colors: typeof colors;
    fonts: typeof fonts;
    space: typeof space;
    radius: typeof radius;
};

/**
 * The CSS custom properties the stylesheet consumes.
 *
 * Derived from the constants above rather than typed out again, so a token
 * cannot exist in one representation and not the other.
 */
export function themeCssVariables(): Record<string, string> {
    const vars: Record<string, string> = {};

    const put = (group: string, source: Record<string, string>): void => {
        for (const [key, value] of Object.entries(source)) {
            vars[`--${group}-${kebab(key)}`] = value;
        }
    };

    put('color', colors);
    put('font', fonts);
    put('space', space);
    put('radius', radius);

    vars['--motion-ok-glow-duration'] = motion.okGlowDuration;
    vars['--motion-live-glow-duration'] = motion.liveGlowDuration;
    vars['--motion-offline-dot-opacity'] = motion.offlineDotOpacity;
    vars['--motion-easing'] = motion.easing;

    return vars;
}

function kebab(value: string): string {
    return value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
