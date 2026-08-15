const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config/config');
const logger = require('../logger/logger');

const execFileAsync = promisify(execFile);

// A dump smaller than this cannot contain a real schema, let alone data.
const MIN_BACKUP_BYTES = 1024;
// mysqldump writes this only after a clean finish, so its absence means truncation.
const DUMP_COMPLETE_MARKER = '-- Dump completed';


class DbBackupManager {
    constructor() {
        this.s3Client = new S3Client({
            region: config.aws.region || 'us-east-1',
            credentials: {
                accessKeyId: config.aws.accessKeyId,
                secretAccessKey: config.aws.secretAccessKey
            }
        });
        this.bucketName = config.aws.s3BucketName;
        this.maxBackups = 10;
        this.backupPrefix = 'database-backups/';
        this.tempBackupDir = path.join(process.cwd(), 'temp_backups');
    }

    async createBackup(reason = 'manual') {
        if (config.isDebugMode) {
            logger.info('DbBackupManager', 'Skipping backup in debug mode', { reason });
            return false;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `backup-${timestamp}.sql`;
        const localPath = path.join(this.tempBackupDir, filename);
        const s3Key = `${this.backupPrefix}${filename}`;

        try {
            logger.info('DbBackupManager', 'Starting database backup', { reason, filename });

            await fs.mkdir(this.tempBackupDir, { recursive: true });

            const { args, env } = this.buildMysqldumpInvocation(localPath);

            logger.debug('DbBackupManager', 'Executing mysqldump');
            await execFileAsync('mysqldump', args, { env });

            // Nothing is uploaded and nothing is rotated unless the dump verifies.
            // A silently-empty dump used to upload happily and then rotate away the
            // last known-good backup.
            await this.verifyBackup(localPath);

            await this.uploadToS3(localPath, s3Key);

            await fs.unlink(localPath);
            logger.debug('DbBackupManager', 'Local backup file cleaned up');

            await this.rotateBackups();

            logger.info('DbBackupManager', 'Backup completed successfully', {
                reason,
                filename,
                s3Key
            });

            return true;

        } catch (error) {
            logger.error('DbBackupManager', 'Backup failed', {
                reason,
                error: error.message,
                stack: error.stack
            });

            try {
                await fs.unlink(localPath);
            } catch (cleanupError) {
                // Two distinct facts: why the backup failed, and why we then could
                // not remove its partial file. This used to log the backup error
                // twice and drop the cleanup failure entirely.
                logger.error('DbBackupManager', 'Cleanup failed', {
                    reason,
                    error: cleanupError.message,
                    stack: cleanupError.stack,
                    originalError: error.message
                });
            }

            return false;
        }
    }

    /**
     * execFile (no shell) with the password in MYSQL_PWD and --result-file instead
     * of shell redirection. Removes the injection/exposure surface of interpolating
     * the password into a command line, and avoids PowerShell writing UTF-16.
     */
    buildMysqldumpInvocation(outputPath) {
        const dbConfig = config.database;

        return {
            args: [
                '-h', String(dbConfig.host),
                '-P', String(dbConfig.port),
                '-u', String(dbConfig.user),
                `--result-file=${outputPath}`,
                String(dbConfig.database)
            ],
            env: { ...process.env, MYSQL_PWD: dbConfig.password }
        };
    }

    async verifyBackup(localPath) {
        const stats = await fs.stat(localPath);

        if (stats.size < MIN_BACKUP_BYTES) {
            throw new Error(
                `Backup verification failed: file is ${stats.size} bytes, below the ${MIN_BACKUP_BYTES} byte floor`
            );
        }

        const tail = await this.readTail(localPath);
        if (!tail.includes(DUMP_COMPLETE_MARKER)) {
            throw new Error('Backup verification failed: dump is missing its completion marker');
        }

        logger.info('DbBackupManager', 'Backup verified', {
            size: stats.size,
            path: localPath
        });

        return true;
    }

    async readTail(localPath, bytes = 4096) {
        const handle = await fs.open(localPath, 'r');
        try {
            const { size } = await handle.stat();
            const length = Math.min(bytes, size);
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, size - length);
            return buffer.toString('utf8');
        } finally {
            await handle.close();
        }
    }

    async uploadToS3(localPath, s3Key) {
        logger.debug('DbBackupManager', 'Uploading to S3', { s3Key });

        const fileContent = await fs.readFile(localPath);

        const command = new PutObjectCommand({
            Bucket: this.bucketName,
            Key: s3Key,
            Body: fileContent,
            ContentType: 'application/sql',
            Metadata: {
                'backup-date': new Date().toISOString(),
                'database': config.database.database
            }
        });

        await this.s3Client.send(command);
        logger.debug('DbBackupManager', 'Upload to S3 completed', { s3Key });
    }

    async listBackups() {
        logger.debug('DbBackupManager', 'Listing backups from S3');

        const command = new ListObjectsV2Command({
            Bucket: this.bucketName,
            Prefix: this.backupPrefix
        });

        const response = await this.s3Client.send(command);
        const backups = response.Contents || [];

        logger.debug('DbBackupManager', 'Backups listed', { count: backups.length });

        return backups.sort((a, b) => b.LastModified - a.LastModified);
    }

    async rotateBackups() {
        logger.debug('DbBackupManager', 'Starting backup rotation');

        const backups = await this.listBackups();

        if (backups.length <= this.maxBackups) {
            logger.debug('DbBackupManager', 'No rotation needed', {
                currentCount: backups.length,
                maxBackups: this.maxBackups
            });
            return;
        }

        const backupsToDelete = backups.slice(this.maxBackups);

        logger.info('DbBackupManager', 'Rotating backups', {
            totalBackups: backups.length,
            toDelete: backupsToDelete.length
        });

        for (const backup of backupsToDelete) {
            await this.deleteBackup(backup.Key);
        }

        logger.info('DbBackupManager', 'Backup rotation completed', {
            remaining: this.maxBackups
        });
    }

    async deleteBackup(key) {
        logger.debug('DbBackupManager', 'Deleting backup', { key });

        const command = new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: key
        });

        await this.s3Client.send(command);
        logger.debug('DbBackupManager', 'Backup deleted', { key });
    }

    async cleanup() {
        try {
            const files = await fs.readdir(this.tempBackupDir);
            for (const file of files) {
                await fs.unlink(path.join(this.tempBackupDir, file));
            }
            logger.debug('DbBackupManager', 'Temp directory cleaned up');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error('DbBackupManager', 'Error cleaning up temp directory', {
                    error: error.message
                });
            }
        }
    }
}

module.exports = DbBackupManager;
