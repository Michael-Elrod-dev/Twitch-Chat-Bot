/**
 * P1-10: a backup that cannot be trusted must not be uploaded, and above all must
 * not trigger rotation. The original failure mode was a silently-empty dump
 * uploading happily and then rotating away the last known-good backup.
 */

const path = require('path');
const os = require('os');
const realFs = require('fs').promises;

jest.mock('child_process', () => ({
    execFile: jest.fn()
}));

jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn(() => ({ send: jest.fn().mockResolvedValue({ Contents: [] }) })),
    PutObjectCommand: jest.fn(),
    ListObjectsV2Command: jest.fn(),
    DeleteObjectCommand: jest.fn()
}));

jest.mock('../../src/config/config', () => ({
    isDebugMode: false,
    database: {
        host: 'localhost',
        port: 3306,
        user: 'testuser',
        password: 'testpass',
        database: 'testdb'
    },
    aws: {
        region: 'us-east-1',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        s3BucketName: 'bucket'
    }
}));

const { execFile } = require('child_process');
const DbBackupManager = require('../../src/database/dbBackupManager');

const VALID_DUMP = `-- MySQL dump 10.13
CREATE TABLE viewers (user_id VARCHAR(50));
${'-- filler line to clear the size floor\n'.repeat(40)}
-- Dump completed on 2026-08-15 12:00:00
`;

describe('DbBackupManager - dump verification', () => {
    let backupManager;
    let tempDir;

    beforeEach(async () => {
        jest.clearAllMocks();
        // resetMocks clears factory implementations before each test, so the
        // mysqldump stub has to be re-armed here or promisify never settles.
        // Stands in for mysqldump: writes a real dump at --result-file so the
        // rest of createBackup (verify, upload, unlink) operates on a real file.
        execFile.mockImplementation(async (file, args, options, callback) => {
            const target = args.find(a => a.startsWith('--result-file='));
            if (target) {
                await realFs.writeFile(target.replace('--result-file=', ''), VALID_DUMP);
            }
            callback(null, { stdout: '', stderr: '' });
        });
        tempDir = await realFs.mkdtemp(path.join(os.tmpdir(), 'backup-verify-'));
        backupManager = new DbBackupManager();
    });

    afterEach(async () => {
        await realFs.rm(tempDir, { recursive: true, force: true });
    });

    const writeDump = async (name, contents) => {
        const filePath = path.join(tempDir, name);
        await realFs.writeFile(filePath, contents);
        return filePath;
    };

    describe('verifyBackup', () => {
        it('should accept a complete dump', async () => {
            const file = await writeDump('good.sql', VALID_DUMP);

            await expect(backupManager.verifyBackup(file)).resolves.toBe(true);
        });

        it('should reject an empty dump', async () => {
            const file = await writeDump('empty.sql', '');

            await expect(backupManager.verifyBackup(file))
                .rejects.toThrow('below the 1024 byte floor');
        });

        it('should reject a suspiciously small dump', async () => {
            const file = await writeDump('tiny.sql', '-- Dump completed\n');

            await expect(backupManager.verifyBackup(file))
                .rejects.toThrow('below the 1024 byte floor');
        });

        it('should reject a truncated dump that never finished', async () => {
            // Large enough to clear the floor, but mysqldump died mid-write.
            const file = await writeDump('truncated.sql', 'x'.repeat(5000));

            await expect(backupManager.verifyBackup(file))
                .rejects.toThrow('missing its completion marker');
        });

        it('should find the marker at the very end of a large dump', async () => {
            const file = await writeDump('big.sql', 'y'.repeat(200000) + '\n-- Dump completed\n');

            await expect(backupManager.verifyBackup(file)).resolves.toBe(true);
        });
    });

    describe('createBackup gating', () => {
        beforeEach(() => {
            backupManager.tempBackupDir = tempDir;
        });

        it('should upload and rotate when the dump verifies', async () => {
            jest.spyOn(backupManager, 'verifyBackup').mockResolvedValue(true);
            const upload = jest.spyOn(backupManager, 'uploadToS3').mockResolvedValue(undefined);
            const rotate = jest.spyOn(backupManager, 'rotateBackups').mockResolvedValue(undefined);

            const result = await backupManager.createBackup('test');

            expect(result).toBe(true);
            expect(upload).toHaveBeenCalled();
            expect(rotate).toHaveBeenCalled();
        });

        it('should upload NOTHING when verification fails', async () => {
            jest.spyOn(backupManager, 'verifyBackup')
                .mockRejectedValue(new Error('Backup verification failed: empty'));
            const upload = jest.spyOn(backupManager, 'uploadToS3').mockResolvedValue(undefined);

            const result = await backupManager.createBackup('test');

            expect(result).toBe(false);
            expect(upload).not.toHaveBeenCalled();
        });

        it('should NOT rotate when verification fails', async () => {
            jest.spyOn(backupManager, 'verifyBackup')
                .mockRejectedValue(new Error('Backup verification failed: empty'));
            const rotate = jest.spyOn(backupManager, 'rotateBackups').mockResolvedValue(undefined);

            await backupManager.createBackup('test');

            // This is the dangerous one: rotating on a bad dump could age out every
            // good backup while only bad ones survive.
            expect(rotate).not.toHaveBeenCalled();
        });

        it('should verify before uploading, not after', async () => {
            const verify = jest.spyOn(backupManager, 'verifyBackup').mockResolvedValue(true);
            const upload = jest.spyOn(backupManager, 'uploadToS3').mockResolvedValue(undefined);
            jest.spyOn(backupManager, 'rotateBackups').mockResolvedValue(undefined);

            await backupManager.createBackup('test');

            expect(verify.mock.invocationCallOrder[0])
                .toBeLessThan(upload.mock.invocationCallOrder[0]);
        });
    });

    describe('failure-path logging', () => {
        beforeEach(() => {
            backupManager.tempBackupDir = tempDir;
        });

        it('should log the CLEANUP failure, not the backup failure twice', async () => {
            const logger = require('../../src/logger/logger');
            jest.spyOn(backupManager, 'verifyBackup')
                .mockRejectedValue(new Error('Backup verification failed'));
            jest.spyOn(realFs, 'unlink')
                .mockRejectedValue(new Error('EBUSY: file is locked'));

            await backupManager.createBackup('test');

            // This logged the backup error a second time and dropped the cleanup
            // failure entirely - so a locked temp file was invisible in the logs.
            expect(logger.error).toHaveBeenCalledWith(
                'DbBackupManager',
                'Cleanup failed',
                expect.objectContaining({
                    error: 'EBUSY: file is locked',
                    originalError: 'Backup verification failed'
                })
            );
        });

        it('should still report the backup failure separately', async () => {
            const logger = require('../../src/logger/logger');
            jest.spyOn(backupManager, 'verifyBackup')
                .mockRejectedValue(new Error('Backup verification failed'));

            const result = await backupManager.createBackup('test');

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                'DbBackupManager',
                'Backup failed',
                expect.objectContaining({ error: 'Backup verification failed' })
            );
        });
    });
});
