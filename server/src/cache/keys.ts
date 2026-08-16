/**
 * Every Redis key is channel-scoped. Nothing in this system may read or write a
 * key that is not prefixed with the channel it belongs to - that is the
 * mechanical guarantee behind tenant isolation in the cache layer.
 */
export function channelKey(channelId: string, ...parts: string[]): string {
    return ['ch', channelId, ...parts].join(':');
}

export const CacheKeys = {
    commands: (channelId: string): string => channelKey(channelId, 'commands'),
    emotes: (channelId: string): string => channelKey(channelId, 'emotes'),
    settings: (channelId: string): string => channelKey(channelId, 'settings'),
    roles: (channelId: string, userId: string): string => channelKey(channelId, 'roles', userId)
} as const;
