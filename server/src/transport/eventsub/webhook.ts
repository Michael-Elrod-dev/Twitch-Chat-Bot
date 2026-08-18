import express, { Router, type Request, type Response } from 'express';
import type { TransportEvent } from '@almosthadai/shared';
import type { Logger } from '../../logger.js';
import {
    EVENTSUB_HEADERS,
    MESSAGE_TYPES,
    type EventSubNotificationBody,
    type EventSubRevocationBody,
    type EventSubVerificationBody,
    type EventSubSubscriptionInfo
} from './messages.js';
import { verifySignature, isTimestampFresh } from './signature.js';
import { normalizeEvent } from './normalize.js';

export const EVENTSUB_WEBHOOK_PATH = '/eventsub/webhook';

/** Bounded, because an unbounded dedup set is a memory leak with extra steps. */
const MAX_SEEN_DELIVERY_IDS = 5_000;

export interface EventSubWebhookOptions {
    secret: string;
    logger: Logger;
    maxSkewMs: number;
    /**
     * Hands a normalized event to the ingest queue.
     * @returns false when the queue refused it, which becomes a 503 so Twitch retries.
     */
    onEvent: (event: TransportEvent) => boolean;
    onRevocation: (subscription: EventSubSubscriptionInfo) => void;
    path?: string;
}

/**
 * The EventSub webhook endpoint.
 *
 * The order of checks is the security contract, and it is deliberate: nothing
 * that could act on attacker-controlled data runs before the signature is
 * proven. Parsing happens after verification, not before.
 *
 * The handler never processes an event inline — it enqueues and returns. Twitch
 * revokes subscriptions whose endpoint is repeatedly slow (facts §3), so doing
 * real work here would eventually turn a slow database into a dead bot.
 */
export function createEventSubRouter(options: EventSubWebhookOptions): Router {
    const { secret, logger, maxSkewMs, onEvent, onRevocation, path = EVENTSUB_WEBHOOK_PATH } = options;
    const router = Router();

    const seenDeliveryIds = new Set<string>();

    // Scoped to this route only: the rest of the app gets ordinary parsed JSON,
    // and only the endpoint that needs the exact bytes pays to keep them.
    const parseWithRawBody = express.json({
        limit: '1mb',
        verify: (req, _res, buf) => {
            (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        }
    });

    router.post(path, parseWithRawBody, (req: Request, res: Response) => {
        const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
        if (!rawBody) {
            // Only reachable if a body parser ran before this router, in which
            // case the signature can never be checked. Loud, because it is a
            // wiring bug that would otherwise look like Twitch misbehaving.
            logger.error('Webhook received without a raw body - check body-parser ordering');
            res.status(400).send('missing raw body');
            return;
        }

        const messageId = header(req, EVENTSUB_HEADERS.messageId);
        const timestamp = header(req, EVENTSUB_HEADERS.messageTimestamp);
        const signature = header(req, EVENTSUB_HEADERS.messageSignature);
        const messageType = header(req, EVENTSUB_HEADERS.messageType);

        if (!messageId || !timestamp || !signature || !messageType) {
            logger.warn({ messageType }, 'Webhook missing required headers');
            res.status(400).send('missing required headers');
            return;
        }

        if (!verifySignature({ secret, messageId, timestamp, rawBody, signature })) {
            // 403 rather than 401: there is no authentication to retry with.
            logger.warn({ messageId }, 'Webhook signature verification failed');
            res.status(403).send('invalid signature');
            return;
        }

        // Signature first, freshness second — an unsigned request does not get
        // to tell us what time it is.
        if (!isTimestampFresh(timestamp, maxSkewMs)) {
            logger.warn({ messageId, timestamp }, 'Webhook timestamp outside the accepted window');
            res.status(403).send('stale timestamp');
            return;
        }

        // Twitch states plainly that a notification may arrive twice. Dedup here
        // keeps duplicates out of the queue entirely; sessions dedup again,
        // because a delivery could also be replayed across a restart.
        if (isDuplicate(seenDeliveryIds, messageId)) {
            logger.debug({ messageId }, 'Duplicate webhook delivery - acknowledging without processing');
            res.status(204).end();
            return;
        }

        switch (messageType) {
        case MESSAGE_TYPES.verification:
            handleVerification(req.body as EventSubVerificationBody, res, logger);
            return;

        case MESSAGE_TYPES.revocation:
            handleRevocation(req.body as EventSubRevocationBody, res, logger, onRevocation);
            return;

        case MESSAGE_TYPES.notification:
            handleNotification(req.body as EventSubNotificationBody, res, logger, messageId, onEvent);
            return;

        default:
            // Unknown types get a 2xx: Twitch should not retry something this
            // build will never understand.
            logger.warn({ messageType }, 'Unknown EventSub message type - acknowledging');
            res.status(204).end();
        }
    });

    return router;
}

function handleVerification(body: EventSubVerificationBody, res: Response, logger: Logger): void {
    const challenge = typeof body?.challenge === 'string' ? body.challenge : '';
    if (challenge === '') {
        logger.warn('Verification challenge missing from body');
        res.status(400).send('missing challenge');
        return;
    }

    logger.info(
        { subscriptionType: body.subscription?.type, condition: body.subscription?.condition },
        'EventSub subscription verified'
    );

    // Plain text, echoed exactly, with a correct Content-Length. Twitch enables
    // the subscription only if this matches byte for byte.
    res.status(200)
        .set('Content-Type', 'text/plain')
        .set('Content-Length', String(Buffer.byteLength(challenge)))
        .send(challenge);
}

function handleRevocation(
    body: EventSubRevocationBody,
    res: Response,
    logger: Logger,
    onRevocation: (subscription: EventSubSubscriptionInfo) => void
): void {
    const subscription = body?.subscription;

    // Error level on purpose: a revoked subscription means the bot has gone
    // deaf in that channel, and it will not fix itself.
    logger.error(
        {
            subscriptionId: subscription?.id,
            subscriptionType: subscription?.type,
            status: subscription?.status,
            condition: subscription?.condition
        },
        'EventSub subscription revoked by Twitch'
    );

    if (subscription) {
        try {
            onRevocation(subscription);
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'Revocation handler failed');
        }
    }

    res.status(204).end();
}

function handleNotification(
    body: EventSubNotificationBody,
    res: Response,
    logger: Logger,
    messageId: string,
    onEvent: (event: TransportEvent) => boolean
): void {
    const subscriptionType = body?.subscription?.type ?? '';
    const payload = (body?.event ?? {}) as Record<string, unknown>;

    const event = normalizeEvent(subscriptionType, payload, messageId);
    if (!event) {
        // Acknowledged, not retried: redelivering a type we do not handle would
        // only waste Twitch's retry budget.
        logger.warn({ subscriptionType }, 'Unhandled subscription type - acknowledging');
        res.status(204).end();
        return;
    }

    if (!onEvent(event)) {
        // 503 makes Twitch redeliver, which is the correct answer to "I am
        // temporarily unable to take this".
        res.status(503).send('ingest queue unavailable');
        return;
    }

    res.status(204).end();
}

function header(req: Request, name: string): string {
    const value = req.headers[name];
    return typeof value === 'string' ? value : '';
}

function isDuplicate(seen: Set<string>, id: string): boolean {
    if (seen.has(id)) return true;

    seen.add(id);
    if (seen.size > MAX_SEEN_DELIVERY_IDS) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
    }
    return false;
}
