import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { LIVE_PATH, LIVE_HEARTBEAT_MS, type LiveEvent } from '@almosthadai/shared';
import type { Logger } from '../logger.js';
import { verifyJwt, JwtError } from '../auth/jwt.js';
import type { ChannelRepository } from '../db/repositories/channelRepository.js';
import type { EventBus } from './eventBus.js';

/**
 * The realtime feed.
 *
 * Authentication happens at the **upgrade**, before the WebSocket exists: a
 * socket that reaches the connection handler is already authenticated and
 * already bound to exactly one channel. There is no subscribe message and no
 * way to ask for a different channel, so the fan-out cannot be talked into
 * crossing tenants. It is the same rule as the REST API, enforced the same way.
 *
 * Browsers cannot set headers on a WebSocket handshake, so the token arrives as
 * a query parameter. That is a real trade: query strings land in access logs.
 * It is acceptable here because these are our own short-lived access tokens
 * (15 minutes, revocable by rotating the signing key), never Twitch's. The
 * alternative, a ticket endpoint issuing single-use handshake codes, is
 * complexity the desktop client does not need yet.
 */

interface LiveClient {
    socket: WebSocket;
    channelId: string;
    login: string;
    /** Cleared on pong; a socket still false at the next sweep is gone. */
    alive: boolean;
}

export interface LiveServerOptions {
    server: Server;
    bus: EventBus;
    channels: ChannelRepository;
    logger: Logger;
    jwtSecret: string | undefined;
    heartbeatMs?: number;
}

export class LiveServer {
    private readonly wss: WebSocketServer;
    private readonly options: LiveServerOptions;
    private readonly clients = new Set<LiveClient>();
    private readonly unsubscribe: () => void;
    private heartbeat: NodeJS.Timeout | null = null;

    constructor(options: LiveServerOptions) {
        this.options = options;

        // noServer: we own the upgrade so authentication can reject before any
        // WebSocket machinery is started for an unauthorized caller.
        this.wss = new WebSocketServer({ noServer: true });

        options.server.on('upgrade', (req, socket, head) => {
            void this.handleUpgrade(req, socket as Duplex, head);
        });

        this.unsubscribe = options.bus.subscribe((channelId, event) => {
            this.broadcast(channelId, event);
        });

        this.startHeartbeat();
    }

    get connectionCount(): number {
        return this.clients.size;
    }

    private async handleUpgrade(
        req: { url?: string | undefined; headers: Record<string, unknown> },
        socket: Duplex,
        head: Buffer
    ): Promise<void> {
        const reject = (status: number, reason: string): void => {
            // A raw HTTP response: there is no WebSocket yet to close politely.
            socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
            socket.destroy();
        };

        try {
            const url = new URL(req.url ?? '/', 'http://placeholder');
            if (url.pathname !== LIVE_PATH) {
                // Not ours. Another upgrade handler may want it; if none does,
                // the socket is closed rather than left hanging.
                reject(404, 'Not Found');
                return;
            }

            if (!this.options.jwtSecret) {
                reject(503, 'Service Unavailable');
                return;
            }

            const token = url.searchParams.get('access_token') ?? '';
            if (token === '') {
                reject(401, 'Unauthorized');
                return;
            }

            let claims;
            try {
                claims = verifyJwt(token, this.options.jwtSecret);
            } catch (err) {
                if (err instanceof JwtError) {
                    this.options.logger.debug({ reason: err.message }, 'Rejected live upgrade');
                    reject(401, 'Unauthorized');
                    return;
                }
                throw err;
            }

            const channel = await this.options.channels.findByBroadcasterId(claims.sub);
            if (!channel) {
                reject(404, 'Not Found');
                return;
            }

            this.wss.handleUpgrade(req as never, socket, head, (ws) => {
                this.register(ws, channel.id, claims.login);
            });
        } catch (err) {
            this.options.logger.error({ err: (err as Error).message }, 'Live upgrade failed');
            reject(500, 'Internal Server Error');
        }
    }

    private register(socket: WebSocket, channelId: string, login: string): void {
        const client: LiveClient = { socket, channelId, login, alive: true };
        this.clients.add(client);

        socket.on('pong', () => { client.alive = true; });
        socket.on('close', () => { this.clients.delete(client); });
        socket.on('error', () => {
            // A socket error is a dead socket; nothing to recover.
            this.clients.delete(client);
            socket.terminate();
        });

        this.options.logger.info(
            { channelId, login, connections: this.clients.size },
            'Live client connected'
        );

        // Sent immediately so a client can render at once rather than waiting
        // for whatever happens next in chat.
        this.send(client, {
            type: 'hello',
            channelId,
            at: new Date().toISOString(),
            login
        });
    }

    /** Delivers to every socket for one channel, and to no others. */
    broadcast(channelId: string, event: LiveEvent): void {
        for (const client of this.clients) {
            if (client.channelId !== channelId) continue;
            this.send(client, event);
        }
    }

    private send(client: LiveClient, event: LiveEvent): void {
        if (client.socket.readyState !== WebSocket.OPEN) return;

        try {
            client.socket.send(JSON.stringify(event));
        } catch (err) {
            // Never propagate: this runs from the pipeline's publish call.
            this.options.logger.debug({ err: (err as Error).message }, 'Live send failed');
            this.clients.delete(client);
        }
    }

    /**
     * A TCP connection to a laptop whose lid closed stays "open" indefinitely.
     * Ping/pong is what makes a gone client actually go, and every unreaped
     * socket is a channel's events being serialized to nowhere.
     */
    private startHeartbeat(): void {
        const interval = this.options.heartbeatMs ?? LIVE_HEARTBEAT_MS;

        this.heartbeat = setInterval(() => {
            for (const client of this.clients) {
                if (!client.alive) {
                    this.options.logger.debug({ channelId: client.channelId }, 'Reaping dead live client');
                    this.clients.delete(client);
                    client.socket.terminate();
                    continue;
                }

                client.alive = false;
                try {
                    client.socket.ping();
                } catch {
                    this.clients.delete(client);
                    client.socket.terminate();
                }
            }
        }, interval);

        // Never hold the process open for a heartbeat.
        this.heartbeat.unref?.();
    }

    async close(): Promise<void> {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.unsubscribe();

        for (const client of this.clients) {
            client.socket.close(1001, 'Server shutting down');
        }
        this.clients.clear();

        await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    }
}
