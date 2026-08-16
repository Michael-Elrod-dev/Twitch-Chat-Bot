import type { TransportEvent } from '@almosthadai/shared';

export type EventHandler = (event: TransportEvent) => Promise<void>;

/**
 * How events reach the server.
 *
 * P1-WP5 supplies the EventSub webhook implementation; FakeTransport drives
 * tests. Nothing downstream of this interface knows which is in play.
 */
export interface Transport {
    readonly name: string;
    /** Begin delivering events to the handler. Idempotent. */
    start: (handler: EventHandler) => Promise<void>;
    stop: () => Promise<void>;
    /** Subscribe to a broadcaster's events. Idempotent per broadcaster. */
    subscribe: (broadcasterTwitchId: string) => Promise<void>;
    unsubscribe: (broadcasterTwitchId: string) => Promise<void>;
}
