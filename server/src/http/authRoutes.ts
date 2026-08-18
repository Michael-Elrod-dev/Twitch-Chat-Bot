import { Router, type Request, type Response } from 'express';
import { apiFailure, apiSuccess } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import type { TwitchOAuthClient, OAuthFlow } from '../twitch/oauth.js';
import { TwitchError } from '../twitch/errors.js';
import type { StateStore } from '../auth/stateStore.js';
import type { OnboardingService } from '../auth/onboarding.js';
import type { AppSessionRepository } from '../db/repositories/appSessionRepository.js';
import type { ChannelRepository } from '../db/repositories/channelRepository.js';
import { generateRefreshToken, signJwt, verifyJwt } from '../auth/jwt.js';
import { isAllowedReturnTo, type ReturnToPolicy } from '../auth/returnTo.js';
import {
    buildSpotifyAuthorizeUrl,
    exchangeSpotifyCode,
    type SpotifyOAuthConfig,
    type SpotifyGrant
} from '../spotify/spotifyAuth.js';

/**
 * The OAuth surface.
 *
 * One registered redirect URI serves all three flows. The flow is carried in
 * the `state` the server itself issued, so a caller cannot select one. That also
 * means the owner registers a single callback URL in the Twitch console instead
 * of three.
 *
 * Nothing in this file logs a code, a token, or a secret. The `code` query
 * parameter is a bearer credential until it is spent, so it is never echoed into
 * a log line, an error response, or a redirect.
 */

export const AUTH_CALLBACK_PATH = '/auth/twitch/callback';
export const SPOTIFY_CALLBACK_PATH = '/auth/spotify/callback';

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
    /** Resolves the signed-in identity to a channel, for the chained connect. */
    channels: ChannelRepository;
    /** Which `return_to` destinations may receive a session. See returnTo.ts. */
    returnToPolicy: ReturnToPolicy;
    /** Spotify connect, per channel. Absent means the routes 503. */
    spotify?: {
        config: SpotifyOAuthConfig;
        /** Stores the grant against the channel that started the flow. */
        onConnected: (twitchUserId: string, grant: SpotifyGrant) => Promise<void>;
        /** Injectable so tests exercise the flow without a network. */
        fetchImpl?: typeof fetch;
    };
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

        /*
         * Refused here, before Twitch is involved, so the failure is a clear
         * 400 rather than a silent drop after a full consent round trip. The
         * callback checks again - see the comment there.
         */
        if (returnTo !== undefined && !isAllowedReturnTo(returnTo, options.returnToPolicy)) {
            logger.warn({ flow }, 'Rejected an OAuth flow with a disallowed return_to');
            res.status(400).json(apiFailure('bad_request', 'return_to is not an allowed destination'));
            return;
        }

        const state = await states.issue(flow, returnTo);

        logger.info({ flow }, 'OAuth flow started');
        res.redirect(oauth.authorizeUrl(flow, state));
    };

    router.get('/auth/twitch/connect', startFlow('channel'));
    router.get('/auth/bot/connect', startFlow('bot'));
    router.get('/auth/app/login', startFlow('signin'));

    /*
     * Spotify connect.
     *
     * Guarded by the app JWT rather than a bare link: this attaches a Spotify
     * account to a channel, so the server must know WHICH channel is asking.
     * The Twitch flows can identify themselves from the consent that follows;
     * this one cannot.
     */
    router.get('/auth/spotify/connect', (req: Request, res: Response) => {
        void (async () => {
            if (!options.spotify) {
                res.status(503).json(apiFailure('unavailable', 'Spotify is not configured on this server'));
                return;
            }
            if (!options.jwtSecret) {
                res.status(503).json(apiFailure('unavailable', 'Authentication is not configured'));
                return;
            }

            // Accepts the token from a header or the query string, because this
            // is opened in a browser where headers cannot be set.
            const header = req.headers.authorization ?? '';
            const token = header.startsWith('Bearer ')
                ? header.slice('Bearer '.length)
                : (typeof req.query['access_token'] === 'string' ? req.query['access_token'] : '');

            /*
             * No usable session? Chain through Twitch sign-in and come back.
             *
             * This route has to be completable by a human in a plain browser -
             * it is how a broadcaster onboards their Spotify - and a browser has
             * no way to attach a bearer token to a link it was handed. Bouncing
             * through sign-in and continuing makes the whole thing one click.
             */
            let claims;
            if (token !== '') {
                try {
                    claims = verifyJwt(token, options.jwtSecret);
                } catch {
                    claims = undefined;
                }
            }

            if (!claims) {
                if (!requireConfigured(res)) return;

                const signInState = await states.issue('signin', undefined, 'spotify');
                logger.info('Spotify connect started without a session - chaining through Twitch sign-in');
                res.redirect(oauth.authorizeUrl('signin', signInState));
                return;
            }

            // The Twitch user id rides in the state, so the callback knows whose
            // channel to attach the Spotify account to without trusting anything
            // the callback itself carries.
            const state = await states.issue('spotify', claims.sub);
            logger.info({ login: claims.login }, 'Spotify connect started');

            res.redirect(buildSpotifyAuthorizeUrl(options.spotify.config, state));
        })().catch((err: unknown) => {
            logger.error({ err: (err as Error).message }, 'Spotify connect failed');
            if (!res.headersSent) res.status(500).json(apiFailure('internal', 'Could not start the Spotify connection'));
        });
    });

    router.get(SPOTIFY_CALLBACK_PATH, (req: Request, res: Response) => {
        void (async () => {
            const oauthError = typeof req.query['error'] === 'string' ? req.query['error'] : '';
            if (oauthError !== '') {
                logger.warn({ oauthError }, 'Spotify authorization was declined');
                res.status(400).type('text/plain').send(`Spotify authorization was declined (${oauthError}).`);
                return;
            }

            const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
            const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';

            // State first, always - the same rule as the Twitch callback.
            const record = await states.consume(state);
            if (!record || record.flow !== 'spotify') {
                logger.warn('Spotify callback with an unknown, expired or replayed state - refusing');
                res.status(403).type('text/plain').send('This link is no longer valid. Please start again.');
                return;
            }

            if (code === '' || !options.spotify) {
                res.status(400).type('text/plain').send('Spotify did not return a code. Please start again.');
                return;
            }

            const grant = await exchangeSpotifyCode(options.spotify.config, code, options.spotify.fetchImpl);
            await options.spotify.onConnected(record.returnTo as string, grant);

            res.status(200).type('text/plain').send('Spotify connected. You can close this tab.');
        })().catch((err: unknown) => {
            const upstream = err instanceof TwitchError;
            logger[upstream ? 'warn' : 'error'](
                { err: (err as Error).message },
                upstream ? 'Spotify authorization could not be completed' : 'Spotify callback failed'
            );
            if (!res.headersSent) {
                res.status(upstream ? 400 : 500).type('text/plain').send(
                    upstream
                        ? 'Spotify could not complete this authorization. It may have expired - please start again.'
                        : 'Authorization failed.'
                );
            }
        });
    });

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
     * The old handle is destroyed and a new one issued on every use. Rotation
     * makes a stolen refresh token usable at most once, and makes its use
     * visible, because the legitimate holder's next attempt fails.
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
    // spending the code before checking would defeat the entire defense.
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

        /*
         * Chained Spotify connect: identity is established, so continue
         * straight into Spotify rather than handing a token to a browser that
         * cannot use one.
         */
        if (record.then === 'spotify') {
            if (!options.spotify) {
                res.status(503).type('text/plain').send('Spotify is not configured on this server.');
                return;
            }

            const channel = await options.channels.findByBroadcasterId(identity.userId);
            if (!channel) {
                // The named error the exit bar asks for. Signing in as the bot
                // account is the easy mistake here, because the consent flows
                // leave that account signed in.
                logger.warn(
                    { login: identity.login, twitchUserId: identity.userId },
                    'Spotify connect attempted by an account with no connected channel'
                );
                res.status(400).type('text/plain').send(
                    `You are signed in to Twitch as "${identity.login}", which has no connected channel here.

` +
                    'Sign out of Twitch, sign in as the broadcaster whose channel is connected, and open the link again.'
                );
                return;
            }

            const spotifyState = await states.issue('spotify', identity.userId);
            logger.info({ login: identity.login, channelId: channel.id }, 'Continuing to Spotify authorization');

            res.redirect(buildSpotifyAuthorizeUrl(options.spotify.config, spotifyState));
            return;
        }

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
            /*
             * Checked again at the point of use. The state is server-issued, so
             * this is belt-and-braces - but this is the line that actually hands
             * out a session, and it should not depend on a check made in another
             * function to be safe. A future code path that issues state without
             * validating would otherwise reopen the hole silently.
             */
            if (!isAllowedReturnTo(record.returnTo, options.returnToPolicy)) {
                logger.error(
                    { login: identity.login },
                    'Refusing to hand a session to a disallowed return_to'
                );
                res.status(400).type('text/plain').send('return_to is not an allowed destination.');
                return;
            }

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
