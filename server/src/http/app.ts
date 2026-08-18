import express, { type Express, type Router } from 'express';
import { apiFailure } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import { createHealthRouter, type ReadinessProbe } from './health.js';

export interface AppOptions {
    logger: Logger;
    version: string;
    probes?: ReadinessProbe[];
    /**
     * Routers that need the unparsed request body — today, only the EventSub
     * webhook, whose HMAC covers the exact bytes Twitch sent.
     *
     * They mount *before* the global JSON parser deliberately. Once
     * `express.json()` has consumed the stream, the raw bytes are gone, and a
     * signature check against a re-serialized parse would fail on nothing worse
     * than a difference in key order.
     */
    rawBodyRouters?: Router[];
    /** Ordinary routers, mounted after the JSON parser. */
    routers?: Router[];
}

export function createApp(options: AppOptions): Express {
    const { logger, version, probes = [], rawBodyRouters = [], routers = [] } = options;
    const app = express();

    // Do not advertise the framework.
    app.disable('x-powered-by');

    for (const router of rawBodyRouters) {
        app.use(router);
    }

    app.use(express.json({ limit: '1mb' }));

    app.use(createHealthRouter({ version, probes }));

    for (const router of routers) {
        app.use(router);
    }

    app.use((_req, res) => {
        res.status(404).json(apiFailure('not_found', 'Endpoint not found'));
    });

    // Express identifies error middleware by arity, so `next` must stay.
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        logger.error({ err }, 'Unhandled request error');
        res.status(500).json(apiFailure('internal', 'Internal server error'));
    });

    return app;
}
