import { Router, type Request, type Response } from 'express';
import { apiFailure, apiSuccess } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import type { TwitchOAuthClient, OAuthFlow } from '../twitch/oauth.js';
import { TwitchError } from '../twitch/errors.js';
import type { StateStore } from '../auth/stateStore.js';
import type { OnboardingService } from '../auth/onboarding.js';
import type { AppSessionRepository } from '../db/repositories/appSessionRepository.js';
import { generateRefreshToken, signJwt } from '../auth/jwt.js';

/**
 * The OAuth surface.
 *
 * One registered redirect URI serves all three flows — the flow is carried in
 * the `state` the server itself issued, so a caller cannot select one. That also
 * means the owner registers a single callback URL in the Twitch console instead
 * of three.
 *
 * Nothing in this file logs a code, a token, or a secret. The `code` query
 * parameter is a bearer credential until it is spent, so it is never echoed —
 * not into a log line, not into an error response, not into a redirect.
 */

export const AUTH_CALLBACK_PATH = '/auth/twitch/callback';

export interface AuthRoutesOptions {
    oauth: TwitchOAuthClient;
    states: StateStore;
    onboarding: OnboardingService;
    sessions: AppSessionRepository;
    logger: Logger;
    jwtSecret: string | undefined;
    jwtTtlSeconds: number;
    /** False when client credentials are absent; every route then 503s honestly. */
    configured: boolean;
}

export function createAuthRouter(options: AuthRoutesOptions): Router {
    const { oauth, states, sessions, logger, configured } = options;
    const router = Router();

    const requireConfigured = (res: Response): boolean => {
        if (configured) return true;
        res.status(503).json(apiFailure('unavailable', 'Twitch credentials are not configured on this server'));
        return false;
    };

    const startFlow = (flow: OAuthFlow) => async (req: Request, res: Response): Promise<void> => {
        if (!requireConfigured(res)) return;

        const returnTo = typeof req.query['return_to'] === 'string' ? req.query['return_to'] : undefined;
        const state = await states.issue(flow, returnTo);

        logger.info({ flow }, 'OAuth flow started');
        res.redirect(oauth.authorizeUrl(flow, state));
    };

    router.get('/auth/twitch/connect', startFlow('channel'));
    router.get('/auth/bot/connect', startFlow('bot'));
    router.get('/auth/app/login', startFlow('signin'));

    router.get(AUTH_CALLBACK_PATH, (req: Request, res: Response) => {
        void handleCallback(req, res, options).catch((err: unknown) => {
            // A code Twitch refuses is an expired or already-spent authorization,
            // which is the user's problem to retry - not this server failing.
            // Reporting it as a 500 would send someone hunting a bug that is not
            // there. The message is Twitch's; the code itself is never echoed.
            const upstream = err instanceof TwitchError;

            logger[upstream ? 'warn' : 'error'](
                { err: (err as Error).message },
                upstream ? 'Authorization could not be completed' : 'OAuth callback failed'
            );

            if (!res.headersSent) {
                res.status(upstream ? 400 : 500).type('text/plain').send(
                    upstream
                        ? 'Twitch could not complete this authorization. It may have expired - please start again.'
                        : 'Authorization failed.'
                );
            }
        });
    });

    /**
     * Trades a refresh token for a new access token.
     *
     * The old handle is destroyed and a new one issued on every use — rotation,
     * so a stolen refresh token is usable at most once, and its use is visible
     * because the legitimate holder's next attempt fails.
     */
    router.post('/auth/app/refresh', (req: Request, res: Response) => {
        void (async () => {
            const provided = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
            if (provided === '') {
                res.status(400).json(apiFailure('bad_request', 'refresh_token is required'));
                return;
            }

            const session = await sessions.resolve(provided);
            if (!session) {
                logger.warn('Refresh token rejected');
                res.status(401).json(apiFailure('unauthorized', 'Refresh token is not valid'));
                return;
            }

            await sessions.revoke(provided);

            if (!options.jwtSecret) {
                res.status(503).json(apiFailure('unavailable', 'Session signing is not configured'));
                return;
            }

            const rotated = generateRefreshToken();
            await sessions.create(rotated.token, session);

            res.status(200).json(apiSuccess({
                access_token: signJwt(
                    { sub: session.twitchUserId, login: session.login },
                    options.jwtSecret,
                    options.jwtTtlSeconds
                ),
                refresh_token: rotated.token,
                expires_in: options.jwtTtlSeconds
            }));
        })().catch((err: unknown) => {
            logger.error({ err: (err as Error).message }, 'Refresh failed');
            if (!res.headersSent) res.status(500).json(apiFailure('internal', 'Refresh failed'));
        });
    });

    router.post('/auth/app/logout', (req: Request, res: Response) => {
        void (async () => {
            const provided = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
            if (provided !== '') await sessions.revoke(provided);
            // Always 204: whether the token existed is not the caller's business.
            res.status(204).end();
        })().catch(() => res.status(204).end());
    });

    return router;
}

async function handleCallback(req: Request, res: Response, options: AuthRoutesOptions): Promise<void> {
    const { oauth, states, onboarding, sessions, logger } = options;

    // Twitch reports a declined consent screen here rather than by not calling back.
    const oauthError = typeof req.query['error'] === 'string' ? req.query['error'] : '';
    if (oauthError !== '') {
        logger.warn({ oauthError }, 'Authorization was declined');
        res.status(400).type('text/plain').send(`Authorization was declined (${oauthError}). You can close this tab.`);
        return;
    }

    const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';

    // State first, always. An unverified callback is an attacker's callback, and
    // spending the code before checking would defeat the entire defence.
    const record = await states.consume(state);
    if (!record) {
        logger.warn('OAuth callback with an unknown, expired or replayed state - refusing');
        res.status(403).type('text/plain').send('This authorization link is no longer valid. Please start again.');
        return;
    }

    if (code === '') {
        res.status(400).type('text/plain').send('Authorization did not return a code. Please start again.');
        return;
    }

    const grant = await oauth.exchangeCode(code);
    const identity = await oauth.validate(grant.accessToken);

    switch (record.flow) {
    case 'channel': {
        const result = await onboarding.onboardChannel(identity, grant);
        res.status(200).type('text/plain').send(
            `Connected ${identity.login}.` +
            (result.missingScopes.length > 0 ? `\nNot granted: ${result.missingScopes.join(', ')}` : '') +
            '\nYou can close this tab.'
        );
        return;
    }

    case 'bot': {
        const result = await onboarding.recordBotConsent(identity, grant);
        res.status(200).type('text/plain').send(
            `Bot account ${identity.login} authorized.` +
            (result.missingScopes.length > 0 ? `\nMISSING REQUIRED SCOPES: ${result.missingScopes.join(', ')}` : '') +
            '\nYou can close this tab.'
        );
        return;
    }

    case 'signin': {
        // Sign-in wants identity and nothing else, so Twitch's token is discarded
        // immediately - the app never holds a Twitch credential.
        await oauth.revoke(grant.accessToken);

        if (!options.jwtSecret) {
            res.status(503).type('text/plain').send('Sign-in is not configured on this server.');
            return;
        }

        const refresh = generateRefreshToken();
        await sessions.create(refresh.token, { twitchUserId: identity.userId, login: identity.login });

        const accessToken = signJwt(
            { sub: identity.userId, login: identity.login },
            options.jwtSecret,
            options.jwtTtlSeconds
        );

        logger.info({ login: identity.login }, 'App sign-in completed');

        if (record.returnTo) {
            // Fragment, not query: a fragment is not sent to servers and does not
            // land in access logs or Referer headers.
            res.redirect(`${record.returnTo}#access_token=${accessToken}&refresh_token=${refresh.token}`);
            return;
        }

        res.status(200).json(apiSuccess({
            access_token: accessToken,
            refresh_token: refresh.token,
            expires_in: options.jwtTtlSeconds
        }));
        return;
    }
    }
}
