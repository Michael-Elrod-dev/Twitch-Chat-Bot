// tests/integration/apiServer.integration.test.js

const request = require('supertest');
const express = require('express');
const ApiServer = require('../../src/api/apiServer');

describe('API Server Integration', () => {
    let apiServer;
    let mockSongToggleService;
    let mockMessageSender;
    let mockConfig;

    beforeEach(() => {
        mockSongToggleService = {
            getCurrentStatus: jest.fn(),
            toggle: jest.fn(),
            toggleSongs: jest.fn()
        };

        mockMessageSender = {
            sendMessage: jest.fn().mockResolvedValue(undefined)
        };

        mockConfig = {
            apiEnabled: true,
            apiKey: 'test-api-key-12345',
            apiPort: 0, // Use random port
            channelName: 'testchannel'
        };

        apiServer = new ApiServer(mockConfig, mockSongToggleService, mockMessageSender);
        apiServer.setupMiddleware();
        apiServer.setupRoutes();
    });

    afterEach(async () => {
        if (apiServer.server) {
            await apiServer.stop();
        }
    });

    describe('Health endpoint', () => {
        it('GET /health should return healthy status', async () => {
            const response = await request(apiServer.app)
                .get('/health')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.status).toBe('healthy');
            expect(response.body.uptime).toBeGreaterThanOrEqual(0);
        });

        it('GET /health should not require authentication', async () => {
            const response = await request(apiServer.app)
                .get('/health')
                .expect(200);

            expect(response.body.success).toBe(true);
        });
    });

    describe('Song status endpoint', () => {
        it('GET /api/songs/status should return current status', async () => {
            mockSongToggleService.getCurrentStatus.mockResolvedValue(true);

            const response = await request(apiServer.app)
                .get('/api/songs/status')
                .set('X-API-Key', 'test-api-key-12345')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.enabled).toBe(true);
        });

        it('GET /api/songs/status should return 401 without API key', async () => {
            const response = await request(apiServer.app)
                .get('/api/songs/status')
                .expect(401);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Missing API key');
        });

        it('GET /api/songs/status should return 403 with invalid API key', async () => {
            const response = await request(apiServer.app)
                .get('/api/songs/status')
                .set('X-API-Key', 'wrong-api-key')
                .expect(403);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Invalid API key');
        });

        it('GET /api/songs/status should return 500 on service error', async () => {
            mockSongToggleService.getCurrentStatus.mockResolvedValue(null);

            const response = await request(apiServer.app)
                .get('/api/songs/status')
                .set('X-API-Key', 'test-api-key-12345')
                .expect(500);

            expect(response.body.success).toBe(false);
        });
    });

    describe('Song toggle endpoint', () => {
        it('POST /api/songs/toggle should toggle songs', async () => {
            mockSongToggleService.toggle.mockResolvedValue({
                success: true,
                enabled: false,
                message: 'Song requests have been turned off'
            });

            const response = await request(apiServer.app)
                .post('/api/songs/toggle')
                .set('X-API-Key', 'test-api-key-12345')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.enabled).toBe(false);
            expect(mockMessageSender.sendMessage).toHaveBeenCalledWith(
                'testchannel',
                'Song requests have been turned off'
            );
        });

        it('POST /api/songs/toggle should return 401 without API key', async () => {
            const response = await request(apiServer.app)
                .post('/api/songs/toggle')
                .expect(401);

            expect(response.body.success).toBe(false);
        });

        it('POST /api/songs/toggle should return 500 on service error', async () => {
            mockSongToggleService.toggle.mockResolvedValue({
                success: false,
                message: 'Service error'
            });

            const response = await request(apiServer.app)
                .post('/api/songs/toggle')
                .set('X-API-Key', 'test-api-key-12345')
                .expect(500);

            expect(response.body.success).toBe(false);
        });
    });

    describe('Song enable endpoint', () => {
        it('POST /api/songs/enable should enable songs', async () => {
            mockSongToggleService.toggleSongs.mockResolvedValue({
                success: true,
                enabled: true,
                message: 'Song requests have been turned on',
                alreadyInState: false
            });

            const response = await request(apiServer.app)
                .post('/api/songs/enable')
                .set('X-API-Key', 'test-api-key-12345')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.enabled).toBe(true);
            expect(mockSongToggleService.toggleSongs).toHaveBeenCalledWith('testchannel', true);
        });
    });

    describe('Song disable endpoint', () => {
        it('POST /api/songs/disable should disable songs', async () => {
            mockSongToggleService.toggleSongs.mockResolvedValue({
                success: true,
                enabled: false,
                message: 'Song requests have been turned off',
                alreadyInState: false
            });

            const response = await request(apiServer.app)
                .post('/api/songs/disable')
                .set('X-API-Key', 'test-api-key-12345')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.enabled).toBe(false);
            expect(mockSongToggleService.toggleSongs).toHaveBeenCalledWith('testchannel', false);
        });
    });

    describe('404 handling', () => {
        it('should return 404 for unknown endpoints', async () => {
            const response = await request(apiServer.app)
                .get('/api/unknown')
                .set('X-API-Key', 'test-api-key-12345')
                .expect(404);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Endpoint not found');
        });
    });

    describe('Server lifecycle', () => {
        it('should not start when apiEnabled is false', async () => {
            const disabledConfig = { ...mockConfig, apiEnabled: false };
            const disabledServer = new ApiServer(disabledConfig, mockSongToggleService, mockMessageSender);

            await disabledServer.start();

            expect(disabledServer.server).toBeNull();
        });

        it('should not start without apiKey', async () => {
            const noKeyConfig = { ...mockConfig, apiKey: null };
            const noKeyServer = new ApiServer(noKeyConfig, mockSongToggleService, mockMessageSender);

            await noKeyServer.start();

            expect(noKeyServer.server).toBeNull();
        });
    });
});
