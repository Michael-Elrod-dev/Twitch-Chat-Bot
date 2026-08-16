import express, { type Express } from 'express';
import { apiFailure } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import { createHealthRouter, type ReadinessProbe } from './health.js';

export interface AppOptions {
    logger: Logger;
    version: string;
    probes?: ReadinessProbe[];
}

export function createApp(options: AppOptions): Express {
    const { logger, version, probes = [] } = options;
    const app = express();

    // Do not advertise the framework.
    app.disable('x-powered-by');

    app.use(express.json({ limit: '1mb' }));

    app.use(createHealthRouter({ version, probes }));

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
