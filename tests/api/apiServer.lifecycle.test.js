/**
 * API server lifecycle across stream cycles (P0-4 extended, P1-12).
 *
 * These bind real sockets on 127.0.0.1 so EADDRINUSE is genuine rather than
 * simulated - that collision is the actual cycle-two failure being fixed. Loopback
 * only; nothing leaves the machine.
 */

const ApiServer = require('../../src/api/apiServer');

const PORT = 34117;

const makeConfig = (overrides = {}) => ({
    apiEnabled: true,
    apiPort: PORT,
    apiKey: 'test-api-key',
    ...overrides
});

describe('ApiServer - lifecycle', () => {
    let servers;
    let songToggleService;
    let messageSender;

    const build = (config = makeConfig()) => {
        const server = new ApiServer(config, songToggleService, messageSender);
        servers.push(server);
        return server;
    };

    beforeEach(() => {
        servers = [];
        songToggleService = {
            getCurrentStatus: jest.fn().mockResolvedValue({ enabled: true }),
            toggle: jest.fn().mockResolvedValue({ enabled: false }),
            toggleSongs: jest.fn().mockResolvedValue({ enabled: false })
        };
        messageSender = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    });

    afterEach(async () => {
        for (const server of servers) {
            await server.stop();
        }
    });

    describe('guards', () => {
        it('should not listen when the API is disabled', async () => {
            const server = build(makeConfig({ apiEnabled: false }));

            await server.start();

            expect(server.server).toBeNull();
        });

        it('should not listen without an API key', async () => {
            const server = build(makeConfig({ apiKey: undefined }));

            await server.start();

            expect(server.server).toBeNull();
        });
    });

    describe('start', () => {
        it('should listen on loopback', async () => {
            const server = build();

            await server.start();

            expect(server.server).not.toBeNull();
            expect(server.server.listening).toBe(true);
        });

        it('should be idempotent', async () => {
            const server = build();

            await server.start();
            const first = server.server;
            await server.start();

            expect(server.server).toBe(first);
        });

        it('should register routes only once across restarts', async () => {
            const server = build();

            await server.start();
            const layerCount = server.app._router.stack.length;
            await server.stop();
            await server.start();

            expect(server.app._router.stack.length).toBe(layerCount);
            expect(server.isConfigured).toBe(true);
        });

        it('should reject when the port is already taken', async () => {
            const first = build();
            await first.start();

            const second = build();

            await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
        });

        it('should leave no server handle after a failed start so a retry can work', async () => {
            const blocker = build();
            await blocker.start();

            const second = build();
            await expect(second.start()).rejects.toThrow();
            expect(second.server).toBeNull();

            await blocker.stop();

            await expect(second.start()).resolves.toBeUndefined();
            expect(second.server.listening).toBe(true);
        });

        it('should NOT reject once it has already resolved', async () => {
            const server = build();
            await server.start();

            // A late error on an already-listening server (client socket blowing up,
            // a late bind failure) previously called reject() on a settled promise.
            const unhandled = jest.fn();
            process.once('unhandledRejection', unhandled);

            server.server.emit('error', new Error('late socket failure'));
            await new Promise((resolve) => setImmediate(resolve));

            expect(unhandled).not.toHaveBeenCalled();
            expect(server.server).not.toBeNull();

            process.removeListener('unhandledRejection', unhandled);
        });
    });

    describe('stop', () => {
        it('should close the listener', async () => {
            const server = build();
            await server.start();
            const handle = server.server;

            await server.stop();

            expect(server.server).toBeNull();
            expect(handle.listening).toBe(false);
        });

        it('should be safe when never started', async () => {
            const server = build();

            await expect(server.stop()).resolves.toBeUndefined();
        });

        it('should be safe to call twice', async () => {
            const server = build();
            await server.start();

            await server.stop();

            await expect(server.stop()).resolves.toBeUndefined();
        });
    });

    describe('across stream cycles', () => {
        it('should restart on the same port without EADDRINUSE', async () => {
            const server = build();

            for (let cycle = 0; cycle < 3; cycle++) {
                await expect(server.start()).resolves.toBeUndefined();
                expect(server.server.listening).toBe(true);
                await server.stop();
            }
        });

        it('should stay listening when start is re-issued each cycle', async () => {
            const server = build();

            await server.start();
            const handle = server.server;

            // How the bot drives it: start() every full-operation entry, never
            // stopped between cycles.
            await server.start();
            await server.start();

            expect(server.server).toBe(handle);
            expect(server.server.listening).toBe(true);
        });
    });
});
