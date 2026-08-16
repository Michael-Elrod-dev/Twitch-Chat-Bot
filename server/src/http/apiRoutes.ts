import { Router, type Request, type Response, type NextFunction } from 'express';
import { apiFailure, apiSuccess } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import { verifyJwt, JwtError, type JwtClaims } from '../auth/jwt.js';
import type { ChannelRepository } from '../db/repositories/channelRepository.js';

/**
 * The authenticated API surface.
 *
 * P1-WP6 ships only what proves the auth machinery works end to end; the
 * resources arrive in P1-WP7. What is load-bearing here is the middleware, and
 * the `/me` stub exists to demonstrate that it actually guards something.
 */

export interface AuthenticatedRequest extends Request {
    claims?: JwtClaims;
}

export function createJwtMiddleware(secret: string | undefined, logger: Logger) {
    return function requireJwt(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
        if (!secret) {
            // Fail closed. A server with no signing key must reject requests, not
            // wave them through on the grounds that it cannot check.
            res.status(503).json(apiFailure('unavailable', 'Authentication is not configured on this server'));
            return;
        }

        const header = req.headers.authorization ?? '';
        if (!header.startsWith('Bearer ')) {
            res.status(401).json(apiFailure('unauthorized', 'A bearer token is required'));
            return;
        }

        try {
            req.claims = verifyJwt(header.slice('Bearer '.length), secret);
            next();
        } catch (err) {
            // Deliberately identical for every rejection reason: telling a caller
            // whether a token was forged or merely expired is free reconnaissance.
            if (err instanceof JwtError) {
                logger.debug({ reason: err.message }, 'Rejected API request');
                res.status(401).json(apiFailure('unauthorized', 'Token is not valid'));
                return;
            }
            throw err;
        }
    };
}

export interface ApiRoutesOptions {
    logger: Logger;
    jwtSecret: string | undefined;
    channels: ChannelRepository;
}

export function createApiRouter(options: ApiRoutesOptions): Router {
    const router = Router();
    const requireJwt = createJwtMiddleware(options.jwtSecret, options.logger);

    /**
     * Proves the whole chain: Twitch sign-in → our JWT → a guarded resource that
     * knows who is asking. The channel list is the smallest useful thing to
     * return, and it is the shape P1-WP7 will build on.
     */
    router.get('/api/v1/me', requireJwt, (req: AuthenticatedRequest, res: Response) => {
        void (async () => {
            const claims = req.claims;
            if (!claims) {
                res.status(401).json(apiFailure('unauthorized', 'Token is not valid'));
                return;
            }

            const channel = await options.channels.findByBroadcasterId(claims.sub);

            res.status(200).json(apiSuccess({
                twitchUserId: claims.sub,
                login: claims.login,
                // Null rather than an error: being signed in and owning no
                // connected channel is an ordinary state, not a failure.
                channel: channel
                    ? { id: channel.id, login: channel.twitchLogin, status: channel.status }
                    : null
            }));
        })().catch((err: unknown) => {
            options.logger.error({ err: (err as Error).message }, '/me failed');
            if (!res.headersSent) res.status(500).json(apiFailure('internal', 'Request failed'));
        });
    });

    return router;
}
