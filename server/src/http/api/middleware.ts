import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { apiFailure } from '@almosthadai/shared';
import type { ZodType } from 'zod';
import type { Logger } from '../../logger.js';
import { verifyJwt, JwtError, type JwtClaims } from '../../auth/jwt.js';
import type { ChannelRepository, ChannelRecord } from '../../db/repositories/channelRepository.js';
import type { ApiKeyRepository } from '../../db/repositories/apiKeyRepository.js';

/**
 * The API's shared middleware.
 *
 * The tenant rule is enforced here and nowhere else: **the credential selects
 * the channel.** No route accepts a channel id, so no route can be pointed at
 * someone else's data — isolation is a property of the routing table rather
 * than of every handler remembering a `WHERE`.
 */

export interface ApiRequest extends Request {
    claims?: JwtClaims;
    /** Resolved from the credential. Present on every channel-scoped route. */
    channel?: ChannelRecord;
    /** What is being rate-limited: a user, or a Stream Deck key. */
    principal?: string;
    /** True when authenticated by API key rather than JWT — key routes are narrower. */
    viaApiKey?: boolean;
}

export function createRequireJwt(secret: string | undefined, logger: Logger): RequestHandler {
    return function requireJwt(req: ApiRequest, res: Response, next: NextFunction): void {
        // An API key already authenticated this request. Demanding a bearer
        // token as well would make the two credentials exclusive-and-required
        // at once; `requireAnyCredential` downstream is what enforces that at
        // least one of them succeeded.
        if (req.viaApiKey) {
            next();
            return;
        }

        if (!secret) {
            // Fail closed. A server that cannot verify must reject, not wave
            // requests through on the grounds that it is unable to check.
            res.status(503).json(apiFailure('unavailable', 'Authentication is not configured on this server'));
            return;
        }

        const header = req.headers.authorization ?? '';
        if (!header.startsWith('Bearer ')) {
            res.status(401).json(apiFailure('unauthorized', 'A bearer token is required'));
            return;
        }

        try {
            const claims = verifyJwt(header.slice('Bearer '.length), secret);
            req.claims = claims;
            req.principal = `user:${claims.sub}`;
            next();
        } catch (err) {
            if (err instanceof JwtError) {
                // Identical for every rejection reason: telling a caller whether
                // a token was forged or merely expired is free reconnaissance.
                logger.debug({ reason: err.message }, 'Rejected API request');
                res.status(401).json(apiFailure('unauthorized', 'Token is not valid'));
                return;
            }
            throw err;
        }
    };
}

/**
 * Resolves the caller's channel from their token.
 *
 * A signed-in user with no connected channel gets a 404 rather than an empty
 * result: the resource genuinely does not exist for them, and pretending it
 * exists-but-is-empty would make "you have not connected a channel" look like
 * "your commands were deleted".
 */
export function createRequireChannel(channels: ChannelRepository): RequestHandler {
    return function requireChannel(req: ApiRequest, res: Response, next: NextFunction): void {
        void (async () => {
            // API-key requests carry their channel already; JWT requests resolve
            // it from the subject.
            if (req.channel) {
                next();
                return;
            }

            const sub = req.claims?.sub;
            if (!sub) {
                res.status(401).json(apiFailure('unauthorized', 'Token is not valid'));
                return;
            }

            const channel = await channels.findByBroadcasterId(sub);
            if (!channel) {
                res.status(404).json(apiFailure('not_found', 'No channel is connected for this account'));
                return;
            }

            req.channel = channel;
            next();
        })().catch(next);
    };
}

/**
 * Accepts `X-Api-Key` as an alternative credential.
 *
 * Scoped to the songs routes only, matching what the Phase-0 loopback API
 * existed for. A Stream Deck button needs to skip a track; it has no business
 * being able to rewrite commands or read analytics, and a key that could would
 * be a far worse thing to have taped inside a stream deck profile.
 */
export function createApiKeyAuth(keys: ApiKeyRepository, channels: ChannelRepository): RequestHandler {
    return function apiKeyAuth(req: ApiRequest, res: Response, next: NextFunction): void {
        void (async () => {
            const presented = req.headers['x-api-key'];
            if (typeof presented !== 'string' || presented === '') {
                next();
                return;
            }

            const record = await keys.resolve(presented);
            if (!record) {
                res.status(401).json(apiFailure('unauthorized', 'API key is not valid'));
                return;
            }

            const channel = await channels.findById(record.channelId);
            if (!channel) {
                res.status(401).json(apiFailure('unauthorized', 'API key is not valid'));
                return;
            }

            req.channel = channel;
            req.viaApiKey = true;
            req.principal = `key:${record.id}`;

            // Best-effort: a failed usage stamp must not fail the request.
            void keys.touch(record.id).catch(() => undefined);

            next();
        })().catch(next);
    };
}

/** Rejects an API key on routes it is not scoped for. */
export function rejectApiKey(req: ApiRequest, res: Response, next: NextFunction): void {
    if (req.viaApiKey) {
        res.status(403).json(apiFailure('forbidden', 'API keys are only accepted on song endpoints'));
        return;
    }
    next();
}

/** Either credential is acceptable; one of them must be present. */
export function requireAnyCredential(req: ApiRequest, res: Response, next: NextFunction): void {
    if (req.channel || req.claims) {
        next();
        return;
    }
    res.status(401).json(apiFailure('unauthorized', 'A bearer token or API key is required'));
}

/**
 * Validates a request body against a schema.
 *
 * The parsed value replaces the body, so handlers receive coerced, trimmed,
 * normalised data and can never accidentally use the raw input.
 */
export function validateBody<T>(schema: ZodType<T>): RequestHandler {
    return function validate(req: Request, res: Response, next: NextFunction): void {
        const result = schema.safeParse(req.body);

        if (!result.success) {
            res.status(400).json(apiFailure(
                'bad_request',
                result.error.issues
                    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
                    .join('; ')
            ));
            return;
        }

        req.body = result.data;
        next();
    };
}

export function validateQuery<T>(schema: ZodType<T>): RequestHandler {
    return function validate(req: Request, res: Response, next: NextFunction): void {
        const result = schema.safeParse(req.query);

        if (!result.success) {
            res.status(400).json(apiFailure(
                'bad_request',
                result.error.issues
                    .map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`)
                    .join('; ')
            ));
            return;
        }

        // Express 4's req.query is a getter on some versions; assigning through
        // a cast keeps the parsed value without fighting the type.
        (req as Request & { validatedQuery?: T }).validatedQuery = result.data;
        next();
    };
}

export function getValidatedQuery<T>(req: Request): T {
    return (req as Request & { validatedQuery?: T }).validatedQuery as T;
}

/**
 * Requires a channel on every route except `/me`.
 *
 * `/me` has to answer for a signed-in user who has not connected a channel yet —
 * that is the state the desktop app shows its onboarding screen from. Every
 * other resource is meaningless without a tenant, so they get the 404 here
 * rather than each handler re-checking.
 */
export function createRequireChannelExceptMe(channels: ChannelRepository): RequestHandler {
    const requireChannel = createRequireChannel(channels);

    return function maybeRequireChannel(req: ApiRequest, res: Response, next: NextFunction): void {
        if (req.path === '/api/v1/me') {
            // Still resolve it when present, so /me can report the channel.
            void (async () => {
                const sub = req.claims?.sub;
                if (sub && !req.channel) {
                    const found = await channels.findByBroadcasterId(sub);
                    if (found) req.channel = found;
                }
                next();
            })().catch(next);
            return;
        }

        requireChannel(req, res, next);
    };
}
