import { describe, it, expect } from 'vitest';
import { hasPermission, rankOf, isUserLevel, rolesFromRecord, NO_ROLES } from './permissions.js';

/**
 * Ported from Phase 0 WP-7.1 (tests/commands/permissions.test.js). The behaviours
 * pinned there are pinned here; the roles now come from channel_roles rather than
 * a global flag, which is the whole point of the port.
 */

const viewer = { isModerator: false, isVip: false, isSubscriber: false, isBroadcaster: false };
const vip = { ...viewer, isVip: true };
const mod = { ...viewer, isModerator: true };
const broadcaster = { ...viewer, isBroadcaster: true };

describe('rank ordering: everyone < vip < mod < broadcaster', () => {
    it('ranks each role above the last', () => {
        expect(rankOf(viewer)).toBeLessThan(rankOf(vip));
        expect(rankOf(vip)).toBeLessThan(rankOf(mod));
        expect(rankOf(mod)).toBeLessThan(rankOf(broadcaster));
    });

    it('ignores subscriber status - it is not a permission tier', () => {
        expect(rankOf({ ...viewer, isSubscriber: true })).toBe(rankOf(viewer));
    });

    it('takes the highest tier a chatter holds', () => {
        expect(rankOf({ ...viewer, isVip: true, isModerator: true })).toBe(rankOf(mod));
        expect(rankOf({ ...viewer, isVip: true, isBroadcaster: true })).toBe(rankOf(broadcaster));
    });
});

describe('hasPermission', () => {
    it('gates every level against every role', () => {
        const rows: { level: string; viewer: boolean; vip: boolean; mod: boolean; broadcaster: boolean }[] = [
            { level: 'everyone', viewer: true, vip: true, mod: true, broadcaster: true },
            { level: 'vip', viewer: false, vip: true, mod: true, broadcaster: true },
            { level: 'mod', viewer: false, vip: false, mod: true, broadcaster: true },
            { level: 'broadcaster', viewer: false, vip: false, mod: false, broadcaster: true }
        ];

        for (const row of rows) {
            expect(hasPermission(row.level, viewer), `${row.level} for viewer`).toBe(row.viewer);
            expect(hasPermission(row.level, vip), `${row.level} for vip`).toBe(row.vip);
            expect(hasPermission(row.level, mod), `${row.level} for mod`).toBe(row.mod);
            expect(hasPermission(row.level, broadcaster), `${row.level} for broadcaster`).toBe(row.broadcaster);
        }
    });

    it('treats an unknown level as everyone - fail OPEN, deliberately', () => {
        // The database CHECK constraint keeps bad values out of the data path;
        // failing closed here would disable a command on a code typo, which is
        // the worse outcome. (Lead decision, Phase 0 WP-7.1.)
        expect(hasPermission('wizard', viewer)).toBe(true);
        expect(hasPermission('', viewer)).toBe(true);
    });
});

describe('isUserLevel', () => {
    it('accepts every real level', () => {
        for (const level of ['everyone', 'vip', 'mod', 'broadcaster']) {
            expect(isUserLevel(level)).toBe(true);
        }
    });

    it('rejects anything else', () => {
        expect(isUserLevel('wizard')).toBe(false);
        expect(isUserLevel('MOD')).toBe(false);
    });
});

describe('rolesFromRecord', () => {
    it('treats an absent channel_roles row as no roles', () => {
        // A chatter with no row has never been seen in this channel; that is not
        // an error, they are simply a plain viewer here.
        expect(rolesFromRecord(null)).toEqual(NO_ROLES);
        expect(hasPermission('mod', rolesFromRecord(null))).toBe(false);
    });

    it('passes a real row through', () => {
        expect(rolesFromRecord({ isModerator: true, isVip: false, isSubscriber: false, isBroadcaster: false }))
            .toMatchObject({ isModerator: true });
    });
});
