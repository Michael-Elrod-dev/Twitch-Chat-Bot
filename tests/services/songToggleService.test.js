// tests/services/songToggleService.test.js

const SongToggleService = require('../../src/services/songToggleService');

describe('SongToggleService', () => {
    let songToggleService;
    let mockTwitchBot;

    beforeEach(() => {
        mockTwitchBot = {
            getUserByName: jest.fn(),
            getCustomRewards: jest.fn(),
            updateCustomReward: jest.fn()
        };

        songToggleService = new SongToggleService(mockTwitchBot);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('getCurrentStatus', () => {
        it('should return enabled status when song request reward exists and is enabled', async () => {
            mockTwitchBot.getUserByName.mockResolvedValue({ id: 'channel-123' });
            mockTwitchBot.getCustomRewards.mockResolvedValue([
                { title: 'Song Request', is_enabled: true }
            ]);

            const result = await songToggleService.getCurrentStatus('testchannel');

            expect(result).toBe(true);
            expect(mockTwitchBot.getUserByName).toHaveBeenCalledWith('testchannel');
        });

        it('should return disabled status when song request reward is disabled', async () => {
            mockTwitchBot.getUserByName.mockResolvedValue({ id: 'channel-123' });
            mockTwitchBot.getCustomRewards.mockResolvedValue([
                { title: 'Song Request', is_enabled: false }
            ]);

            const result = await songToggleService.getCurrentStatus('testchannel');

            expect(result).toBe(false);
        });

        it('should return null when channel not found', async () => {
            mockTwitchBot.getUserByName.mockResolvedValue(null);

            const result = await songToggleService.getCurrentStatus('nonexistent');

            expect(result).toBeNull();
        });

        it('should return null when song request reward not found', async () => {
            mockTwitchBot.getUserByName.mockResolvedValue({ id: 'channel-123' });
            mockTwitchBot.getCustomRewards.mockResolvedValue([
                { title: 'Other Reward', is_enabled: true }
            ]);

            const result = await songToggleService.getCurrentStatus('testchannel');

            expect(result).toBeNull();
        });

        it('should be case insensitive for reward title', async () => {
            mockTwitchBot.getUserByName.mockResolvedValue({ id: 'channel-123' });
            mockTwitchBot.getCustomRewards.mockResolvedValue([
                { title: 'SONG REQUEST', is_enabled: true }
            ]);

            const result = await songToggleService.getCurrentStatus('testchannel');

            expect(result).toBe(true);
        });

        it('should return null on error', async () => {
            mockTwitchBot.getUserByName.mockRejectedValue(new Error('API Error'));

            const result = await songToggleService.getCurrentStatus('testchannel');

            expect(result).toBeNull();
        });
    });

    describe('toggleSongs', () => {
        const songReward = { id: 'reward-1', title: 'Song Request', is_enabled: false };
        const skipReward = { id: 'reward-2', title: 'Skip Song Queue', is_enabled: false };

        beforeEach(() => {
            mockTwitchBot.getUserByName.mockResolvedValue({ id: 'channel-123' });
            mockTwitchBot.getCustomRewards.mockResolvedValue([songReward, skipReward]);
            mockTwitchBot.updateCustomReward.mockResolvedValue({});
        });

        it('should enable both song-related rewards', async () => {
            const result = await songToggleService.toggleSongs('testchannel', true);

            expect(result.success).toBe(true);
            expect(result.enabled).toBe(true);
            expect(result.message).toContain('turned on');
            expect(mockTwitchBot.updateCustomReward).toHaveBeenCalledTimes(2);
            expect(mockTwitchBot.updateCustomReward).toHaveBeenCalledWith(
                'channel-123',
                'reward-1',
                { is_enabled: true }
            );
            expect(mockTwitchBot.updateCustomReward).toHaveBeenCalledWith(
                'channel-123',
                'reward-2',
                { is_enabled: true }
            );
        });

        it('should disable both song-related rewards', async () => {
            mockTwitchBot.getCustomRewards.mockResolvedValue([
                { ...songReward, is_enabled: true },
                { ...skipReward, is_enabled: true }
            ]);

            const result = await songToggleService.toggleSongs('testchannel', false);

            expect(result.success).toBe(true);
            expect(result.enabled).toBe(false);
            expect(result.message).toContain('turned off');
        });

        it('should return alreadyInState when already in requested state', async () => {
            mockTwitchBot.getCustomRewards.mockResolvedValue([
                { ...songReward, is_enabled: true },
                { ...skipReward, is_enabled: true }
            ]);

            const result = await songToggleService.toggleSongs('testchannel', true);

            expect(result.success).toBe(true);
            expect(result.alreadyInState).toBe(true);
            expect(result.message).toContain('already');
            expect(mockTwitchBot.updateCustomReward).not.toHaveBeenCalled();
        });

        it('should return failure when channel not found', async () => {
            mockTwitchBot.getUserByName.mockResolvedValue(null);

            const result = await songToggleService.toggleSongs('nonexistent', true);

            expect(result.success).toBe(false);
            expect(result.message).toBe('Channel not found');
            expect(result.enabled).toBeNull();
        });

        it('should return failure when song request reward not found', async () => {
            mockTwitchBot.getCustomRewards.mockResolvedValue([skipReward]);

            const result = await songToggleService.toggleSongs('testchannel', true);

            expect(result.success).toBe(false);
            expect(result.message).toContain('Could not find');
        });

        it('should return failure when skip queue reward not found', async () => {
            mockTwitchBot.getCustomRewards.mockResolvedValue([songReward]);

            const result = await songToggleService.toggleSongs('testchannel', true);

            expect(result.success).toBe(false);
            expect(result.message).toContain('Could not find');
        });

        it('should handle API errors gracefully', async () => {
            mockTwitchBot.updateCustomReward.mockRejectedValue(new Error('API Error'));

            const result = await songToggleService.toggleSongs('testchannel', true);

            expect(result.success).toBe(false);
            expect(result.message).toContain('Failed');
            expect(result.enabled).toBeNull();
        });
    });

    describe('toggle', () => {
        it('should toggle from enabled to disabled', async () => {
            mockTwitchBot.getUserByName.mockResolvedValue({ id: 'channel-123' });
            mockTwitchBot.getCustomRewards.mockResolvedValue([
                { id: 'reward-1', title: 'Song Request', is_enabled: true },
                { id: 'reward-2', title: 'Skip Song Queue', is_enabled: true }
            ]);
            mockTwitchBot.updateCustomReward.mockResolvedValue({});

            const result = await songToggleService.toggle('testchannel');

            expect(result.success).toBe(true);
            expect(result.enabled).toBe(false);
        });

        it('should toggle from disabled to enabled', async () => {
            mockTwitchBot.getUserByName.mockResolvedValue({ id: 'channel-123' });
            mockTwitchBot.getCustomRewards.mockResolvedValue([
                { id: 'reward-1', title: 'Song Request', is_enabled: false },
                { id: 'reward-2', title: 'Skip Song Queue', is_enabled: false }
            ]);
            mockTwitchBot.updateCustomReward.mockResolvedValue({});

            const result = await songToggleService.toggle('testchannel');

            expect(result.success).toBe(true);
            expect(result.enabled).toBe(true);
        });

        it('should return failure when cannot determine current status', async () => {
            mockTwitchBot.getUserByName.mockResolvedValue(null);

            const result = await songToggleService.toggle('testchannel');

            expect(result.success).toBe(false);
            expect(result.message).toContain('Could not determine');
        });
    });
});
