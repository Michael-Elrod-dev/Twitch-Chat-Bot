import { describe, it, expect } from 'vitest';
import { assertSafeTestDatabase, UnsafeTestDatabaseError } from './testing.js';

/**
 * The guard that makes "tests never touch the development database" a rule the
 * code enforces rather than one a person remembers. Pointing the suites at that
 * database once destroyed the owner's production import.
 */
describe('assertSafeTestDatabase', () => {
    it('refuses the development database by name', () => {
        expect(() => assertSafeTestDatabase('postgres://almosthadai:pw@localhost:5432/almosthadai'))
            .toThrow(UnsafeTestDatabaseError);
    });

    it('refuses it regardless of user, host or port', () => {
        // The database NAME is the thing that identifies it - a different role
        // or a forwarded port is the same data.
        for (const url of [
            'postgres://test:test@127.0.0.1:5432/almosthadai',
            'postgres://almosthadai_app:pw@postgres:5432/almosthadai',
            'postgres://u:p@some.remote.host:6543/almosthadai'
        ]) {
            expect(() => assertSafeTestDatabase(url)).toThrow(UnsafeTestDatabaseError);
        }
    });

    it('allows a throwaway test database', () => {
        expect(() => assertSafeTestDatabase('postgres://test:test@127.0.0.1:55432/test')).not.toThrow();
    });

    it('says how to get a safe one, rather than only refusing', () => {
        try {
            assertSafeTestDatabase('postgres://x:y@h:5432/almosthadai');
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as Error).message).toContain('test-db.sh');
        }
    });

    it('does not block on an unparseable URL - connect will report it better', () => {
        expect(() => assertSafeTestDatabase('not a url at all')).not.toThrow();
    });
});
