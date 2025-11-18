// src/database/dbBackupManager.js

const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config/config');
const logger = require('../logger/logger');

const execAsync = promisify(exec);


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

            const dumpCommand = this.buildMysqldumpCommand(localPath);

            logger.debug('DbBackupManager', 'Executing mysqldump');
            await execAsync(dumpCommand);

            const stats = await fs.stat(localPath);
            logger.debug('DbBackupManager', 'Backup file created', {
                size: stats.size,
                path: localPath
            });

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
                logger.error('DbBackupManager', 'Cleanup failed', {
                    reason,
                    error: error.message,
                    stack: error.stack
                });
            }

            return false;
        }
    }

    buildMysqldumpCommand(outputPath) {
        const dbConfig = config.database;
        return `mysqldump -h ${dbConfig.host} -P ${dbConfig.port} -u ${dbConfig.user} -p${dbConfig.password} ${dbConfig.database} > "${outputPath}"`;
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
