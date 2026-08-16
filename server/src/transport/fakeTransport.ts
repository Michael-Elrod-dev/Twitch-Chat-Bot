import type { TransportEvent } from '@almosthadai/shared';
import type { Transport, EventHandler } from './types.js';

/**
 * Test transport. Lets a test push synthetic EventSub-shaped events and observe
 * exactly which broadcasters are subscribed.
 */
export class FakeTransport implements Transport {
    readonly name = 'fake';

    readonly subscribed = new Set<string>();
    private handler: EventHandler | null = null;
    private started = false;

    async start(handler: EventHandler): Promise<void> {
        if (this.started) return;
        this.handler = handler;
        this.started = true;
    }

    async stop(): Promise<void> {
        this.started = false;
        this.handler = null;
    }

    async subscribe(broadcasterTwitchId: string): Promise<void> {
        this.subscribed.add(broadcasterTwitchId);
    }

    async unsubscribe(broadcasterTwitchId: string): Promise<void> {
        this.subscribed.delete(broadcasterTwitchId);
    }

    /** Drives one event through whatever is listening. */
    async emit(event: TransportEvent): Promise<void> {
        if (!this.handler) {
            throw new Error('FakeTransport.emit called before start()');
        }
        await this.handler(event);
    }

    get isStarted(): boolean {
        return this.started;
    }
}
