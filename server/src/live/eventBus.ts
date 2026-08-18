import type { LiveEvent } from '@almosthadai/shared';

/**
 * The seam between the pipeline and anything watching it.
 *
 * Deliberately a plain synchronous emitter with no queue and no delivery
 * guarantee. A realtime feed is a view. A dropped frame costs a UI one stale
 * moment, and the REST API already answers "what is the state now". Making this
 * reliable would mean buffering per subscriber and deciding what to do when one
 * stalls, which is real cost for a guarantee nothing here needs.
 *
 * The critical property is the opposite one. Publishing must never be able to
 * affect the pipeline. A subscriber that throws, blocks, or is simply gone
 * must not delay a chat response or fail an event, so every listener is called
 * inside a try/catch and nothing is awaited.
 */

export type LiveListener = (channelId: string, event: LiveEvent) => void;

export interface EventBus {
    publish: (channelId: string, event: LiveEvent) => void;
    subscribe: (listener: LiveListener) => () => void;
}

export function createEventBus(onListenerError?: (err: Error) => void): EventBus {
    const listeners = new Set<LiveListener>();

    return {
        publish: (channelId, event) => {
            for (const listener of listeners) {
                try {
                    listener(channelId, event);
                } catch (err) {
                    // Swallowed on purpose. The pipeline is mid-chat-message;
                    // a broken subscriber is not its problem to surface.
                    onListenerError?.(err as Error);
                }
            }
        },

        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}

/** A bus that goes nowhere, for tests and for sessions with no watchers. */
export const NULL_EVENT_BUS: EventBus = {
    publish: () => undefined,
    subscribe: () => () => undefined
};
