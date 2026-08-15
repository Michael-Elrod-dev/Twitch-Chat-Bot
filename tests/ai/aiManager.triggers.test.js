/**
 * P1-5: a command is never swallowed by the AI mention path.
 */

describe('P1-5: commands beat the AI mention path', () => {
    const AIManager = require('../../src/ai/aiManager');
    let aiManager;

    beforeEach(() => {
        jest.resetModules();
        aiManager = new AIManager();
    });

    it('should trigger on a plain mention', () => {
        expect(aiManager.shouldTriggerText('hey almosthadai how are you')).toBe(true);
        expect(aiManager.shouldTriggerText('@almosthadai hello')).toBe(true);
    });

    it('should NOT trigger on a command that happens to name the bot', () => {
        // "!stats almosthadai" was swallowed by the AI path and burned rate limit.
        expect(aiManager.shouldTriggerText('!stats almosthadai')).toBe(false);
        expect(aiManager.shouldTriggerText('!followage @almosthadai')).toBe(false);
    });

    it('should NOT trigger on any command at all', () => {
        expect(aiManager.shouldTriggerText('!commands')).toBe(false);
        expect(aiManager.shouldTriggerText('!ai off')).toBe(false);
    });

    it('should ignore leading whitespace before the bang', () => {
        expect(aiManager.shouldTriggerText('   !stats almosthadai')).toBe(false);
    });

    it('should not trigger on unrelated chat', () => {
        expect(aiManager.shouldTriggerText('what a play')).toBe(false);
    });

    it('should strip triggers using the configured list', () => {
        expect(aiManager.extractPrompt('@almosthadai what is up', 'text')).toBe('what is up');
        expect(aiManager.extractPrompt('almosthadai hello', 'text')).toBe('hello');
    });

    it('should return null when only the trigger was said', () => {
        expect(aiManager.extractPrompt('almosthadai', 'text')).toBeNull();
        expect(aiManager.extractPrompt('@almosthadai', 'text')).toBeNull();
    });

    it('should leave non-text trigger types alone', () => {
        expect(aiManager.extractPrompt('almosthadai hi', 'other')).toBe('almosthadai hi');
    });
});
