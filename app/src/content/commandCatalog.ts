import type { Command, UserLevel } from '@almosthadai/shared';

/**
 * What a built-in command does, as the server describes it.
 *
 * **The map that used to live here is gone.** It listed all seventeen handler
 * names against their behavior, and its cost was exactly what it looks like: a
 * built-in added on the server rendered "A built-in behavior" until somebody
 * remembered to edit a file in a different workspace. `description` is now a
 * field on the handler's own registration, reconciled onto the command row and
 * served on the wire, so the sentence and the behavior change together.
 *
 * The fallback survives, and only as a fallback. A handler-backed row whose
 * description has not been written yet, meaning a built-in whose channel session
 * has not started since it was added, is still a built-in, and saying so is
 * honest where an empty cell would read as a broken row.
 */
export function describeHandler(command: Pick<Command, 'description'>): string {
    return command.description ?? 'A built-in behavior';
}

/**
 * The permission tiers as the WHO chips label them.
 *
 * `broadcaster` reads "Just you" rather than "Broadcaster": this app has one
 * user and it is the broadcaster, so the second person is both shorter and
 * what the design draws.
 */
export const USER_LEVEL_LABELS: Readonly<Record<UserLevel, string>> = {
    everyone: 'Everyone',
    vip: 'VIPs',
    mod: 'Mods',
    broadcaster: 'Just you'
};

/** The order the chips appear in, lowest tier first. */
export const USER_LEVEL_ORDER: readonly UserLevel[] = ['everyone', 'vip', 'mod', 'broadcaster'];
