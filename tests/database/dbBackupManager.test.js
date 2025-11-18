// tests/database/dbBackupManager.test.js

const DbBackupManager = require('../../src/database/dbBackupManager');

// Mock logger
jest.mock('../../src/logger/logger', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

// Mock config
jest.mock('../../src/config/config', () => ({
    isDebugMode: false,
    aws: {
        region: 'us-east-1',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
        s3BucketName: 'test-bucket'
    },
    database: {
        host: 'localhost',
        port: 3306,
        user: 'testuser',
        password: 'testpass',
        database: 'testdb'
    }
}));

const logger = require('../../src/logger/logger');
const config = require('../../src/config/config');

describe('DbBackupManager', () => {
    let backupManager;

    beforeEach(() => {
        jest.clearAllMocks();
        backupManager = new DbBackupManager();
    });

    describe('constructor', () => {
        it('should initialize with correct configuration', () => {
            expect(backupManager.bucketName).toBe('test-bucket');
            expect(backupManager.maxBackups).toBe(10);
            expect(backupManager.backupPrefix).toBe('database-backups/');
        });
    });

    describe('buildMysqldumpCommand', () => {
        it('should build command with correct parameters', () => {
            const outputPath = '/tmp/backup.sql';
            const command = backupManager.buildMysqldumpCommand(outputPath);

            expect(command).toContain('mysqldump');
            expect(command).toContain('-h localhost');
            expect(command).toContain('-P 3306');
            expect(command).toContain('-u testuser');
            expect(command).toContain('-ptestpass');
            expect(command).toContain('testdb');
            expect(command).toContain(`> "${outputPath}"`);
        });
    });

    describe('createBackup', () => {
        it('should skip backup in debug mode', async () => {
            config.isDebugMode = true;

            const result = await backupManager.createBackup('test');

            expect(result).toBe(false);
            expect(logger.info).toHaveBeenCalledWith(
                'DbBackupManager',
                'Skipping backup in debug mode',
                { reason: 'test' }
            );

            config.isDebugMode = false; // Reset
        });

        it('should log when starting backup', async () => {
            // Mock the internal methods to avoid complex mocking
            jest.spyOn(backupManager.s3Client, 'send').mockResolvedValue({});
            jest.spyOn(backupManager, 'rotateBackups').mockResolvedValue(undefined);

            // Mock fs and exec at a higher level by spying on internal methods
            const createBackupSpy = jest.spyOn(backupManager, 'createBackup');

            // Just verify the method was called and logs were generated
            await backupManager.createBackup('scheduled').catch(() => {});

            expect(logger.info).toHaveBeenCalledWith(
                'DbBackupManager',
                'Starting database backup',
                expect.objectContaining({ reason: 'scheduled' })
            );
        });
    });

    describe('listBackups', () => {
        it('should list backups sorted by date descending', async () => {
            const mockBackups = {
                Contents: [
                    { Key: 'database-backups/backup-1.sql', LastModified: new Date('2025-01-01') },
                    { Key: 'database-backups/backup-3.sql', LastModified: new Date('2025-01-03') },
                    { Key: 'database-backups/backup-2.sql', LastModified: new Date('2025-01-02') }
                ]
            };
            jest.spyOn(backupManager.s3Client, 'send').mockResolvedValue(mockBackups);

            const result = await backupManager.listBackups();

            expect(result).toHaveLength(3);
            expect(result[0].Key).toBe('database-backups/backup-3.sql');
            expect(result[2].Key).toBe('database-backups/backup-1.sql');
        });

        it('should handle empty bucket', async () => {
            jest.spyOn(backupManager.s3Client, 'send').mockResolvedValue({ Contents: [] });

            const result = await backupManager.listBackups();

            expect(result).toEqual([]);
        });

        it('should handle no Contents in response', async () => {
            jest.spyOn(backupManager.s3Client, 'send').mockResolvedValue({});

            const result = await backupManager.listBackups();

            expect(result).toEqual([]);
        });
    });

    describe('rotateBackups', () => {
        it('should delete oldest backups when exceeding max count', async () => {
            const mockBackups = Array.from({ length: 12 }, (_, i) => ({
                Key: `database-backups/backup-${i}.sql`,
                LastModified: new Date(2025, 0, 12 - i)
            }));

            const mockSend = jest.spyOn(backupManager.s3Client, 'send')
                .mockResolvedValue({ Contents: mockBackups });

            const deleteBackupSpy = jest.spyOn(backupManager, 'deleteBackup')
                .mockResolvedValue(undefined);

            await backupManager.rotateBackups();

            expect(deleteBackupSpy).toHaveBeenCalledTimes(2);
            expect(logger.info).toHaveBeenCalledWith(
                'DbBackupManager',
                'Rotating backups',
                expect.objectContaining({
                    totalBackups: 12,
                    toDelete: 2
                })
            );
        });

        it('should not delete backups when under max count', async () => {
            const mockBackups = Array.from({ length: 5 }, (_, i) => ({
                Key: `database-backups/backup-${i}.sql`,
                LastModified: new Date(2025, 0, 5 - i)
            }));

            jest.spyOn(backupManager.s3Client, 'send')
                .mockResolvedValue({ Contents: mockBackups });

            const deleteBackupSpy = jest.spyOn(backupManager, 'deleteBackup')
                .mockResolvedValue(undefined);

            await backupManager.rotateBackups();

            expect(deleteBackupSpy).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'DbBackupManager',
                'No rotation needed',
                expect.objectContaining({
                    currentCount: 5,
                    maxBackups: 10
                })
            );
        });
    });

    describe('deleteBackup', () => {
        it('should delete backup from S3', async () => {
            const mockSend = jest.spyOn(backupManager.s3Client, 'send')
                .mockResolvedValue({});

            await backupManager.deleteBackup('database-backups/old-backup.sql');

            expect(mockSend).toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'DbBackupManager',
                'Deleting backup',
                { key: 'database-backups/old-backup.sql' }
            );
        });

        it('should handle delete error', async () => {
            const deleteError = new Error('Access denied');
            jest.spyOn(backupManager.s3Client, 'send')
                .mockRejectedValue(deleteError);

            await expect(
                backupManager.deleteBackup('test-key')
            ).rejects.toThrow('Access denied');
        });
    });
});
