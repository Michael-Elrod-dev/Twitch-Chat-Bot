/**
 * The seam the real Helix client drops into.
 *
 * Deliberately minimal. The reconciler needs exactly three operations, and a
 * smaller interface is a smaller thing to fake honestly.
 */

export interface EventSubCondition {
    [key: string]: string;
}

export interface EventSubSubscription {
    id: string;
    type: string;
    version: string;
    status: string;
    condition: EventSubCondition;
}

export interface CreateSubscriptionInput {
    type: string;
    version: string;
    condition: EventSubCondition;
    transport: {
        method: 'webhook';
        callback: string;
        secret: string;
    };
}

export interface HelixClient {
    listEventSubSubscriptions: () => Promise<EventSubSubscription[]>;
    createEventSubSubscription: (input: CreateSubscriptionInput) => Promise<EventSubSubscription>;
    deleteEventSubSubscription: (id: string) => Promise<void>;
}

/**
 * In-memory Helix. Used by the reconciler tests, and by a running server with
 * no Helix credentials, where the reconciler runs in dry-run mode and never
 * calls it.
 */
export class FakeHelixClient implements HelixClient {
    private readonly subscriptions = new Map<string, EventSubSubscription>();
    private nextId = 1;

    readonly created: CreateSubscriptionInput[] = [];
    readonly deleted: string[] = [];

    /** Fails the next N calls of the named operation, for error-path tests. */
    failCreate = 0;
    failDelete = 0;

    seed(subscription: Omit<EventSubSubscription, 'id'> & { id?: string }): EventSubSubscription {
        const id = subscription.id ?? `seeded-${this.nextId++}`;
        const stored: EventSubSubscription = { ...subscription, id };
        this.subscriptions.set(id, stored);
        return stored;
    }

    async listEventSubSubscriptions(): Promise<EventSubSubscription[]> {
        return [...this.subscriptions.values()];
    }

    async createEventSubSubscription(input: CreateSubscriptionInput): Promise<EventSubSubscription> {
        if (this.failCreate > 0) {
            this.failCreate--;
            throw new Error('helix create failed');
        }

        this.created.push(input);
        const created: EventSubSubscription = {
            id: `created-${this.nextId++}`,
            type: input.type,
            version: input.version,
            // Twitch does not enable a webhook subscription until the callback
            // echoes the challenge, so this is the honest initial status.
            status: 'webhook_callback_verification_pending',
            condition: input.condition
        };
        this.subscriptions.set(created.id, created);
        return created;
    }

    async deleteEventSubSubscription(id: string): Promise<void> {
        if (this.failDelete > 0) {
            this.failDelete--;
            throw new Error('helix delete failed');
        }

        this.deleted.push(id);
        this.subscriptions.delete(id);
    }
}
