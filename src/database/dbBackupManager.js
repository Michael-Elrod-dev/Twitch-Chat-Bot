// src/database/dbBackupManager.js

const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config/config');
const logger = require('../logger/logger');

const execAsync = promisify(exec);

/**
 * Manages database backups to S3 with automatic rotation
 * - Creates MySQL backups using mysqldump
 * - Uploads to S3 bucket
 * - Maintains up to 10 backup versions
 * - Only runs when stream is live (not in debug mode)
 */
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

    /**
     * Creates a MySQL database backup and uploads it to S3
     * @param {string} reason - Reason for backup (e.g., 'scheduled', 'shutdown')
     * @returns {Promise<boolean>} - Success status
     */
    async createBackup(reason = 'manual') {
        // Skip backups in debug mode
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

            // Ensure temp directory exists
            await fs.mkdir(this.tempBackupDir, { recursive: true });

            // Create mysqldump command
            const dumpCommand = this.buildMysqldumpCommand(localPath);

            // Execute mysqldump
            logger.debug('DbBackupManager', 'Executing mysqldump');
            await execAsync(dumpCommand);

            // Verify backup file was created
            const stats = await fs.stat(localPath);
            logger.debug('DbBackupManager', 'Backup file created', {
                size: stats.size,
                path: localPath
            });

            // Upload to S3
            await this.uploadToS3(localPath, s3Key);

            // Clean up local file
            await fs.unlink(localPath);
            logger.debug('DbBackupManager', 'Local backup file cleaned up');

            // Rotate old backups
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

            // Clean up local file if it exists
            try {
                await fs.unlink(localPath);
            } catch (cleanupError) {
                // Ignore cleanup errors
            }

            return false;
        }
    }

    /**
     * Builds the mysqldump command with proper credentials
     * @param {string} outputPath - Path for the backup file
     * @returns {string} - mysqldump command
     */
    buildMysqldumpCommand(outputPath) {
        const dbConfig = config.database;

        // Build mysqldump command with credentials
        // Note: Using password on command line is not ideal for production,
        // but works for this use case. Consider using .my.cnf for better security.
        const command = `mysqldump -h ${dbConfig.host} -P ${dbConfig.port} -u ${dbConfig.user} -p${dbConfig.password} ${dbConfig.database} > "${outputPath}"`;

        return command;
    }

    /**
     * Uploads a backup file to S3
     * @param {string} localPath - Local file path
     * @param {string} s3Key - S3 object key
     */
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

    /**
     * Lists all backup files in S3
     * @returns {Promise<Array>} - Array of backup objects with Key and LastModified
     */
    async listBackups() {
        logger.debug('DbBackupManager', 'Listing backups from S3');

        const command = new ListObjectsV2Command({
            Bucket: this.bucketName,
            Prefix: this.backupPrefix
        });

        const response = await this.s3Client.send(command);
        const backups = response.Contents || [];

        logger.debug('DbBackupManager', 'Backups listed', { count: backups.length });

        // Sort by LastModified descending (newest first)
        return backups.sort((a, b) => b.LastModified - a.LastModified);
    }

    /**
     * Rotates backups, keeping only the most recent 10
     * Deletes oldest backups when count exceeds maxBackups
     */
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

        // Delete backups beyond the max count
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

    /**
     * Deletes a specific backup from S3
     * @param {string} key - S3 object key
     */
    async deleteBackup(key) {
        logger.debug('DbBackupManager', 'Deleting backup', { key });

        const command = new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: key
        });

        await this.s3Client.send(command);
        logger.debug('DbBackupManager', 'Backup deleted', { key });
    }

    /**
     * Cleans up the temp backup directory
     */
    async cleanup() {
        try {
            const files = await fs.readdir(this.tempBackupDir);
            for (const file of files) {
                await fs.unlink(path.join(this.tempBackupDir, file));
            }
            logger.debug('DbBackupManager', 'Temp directory cleaned up');
        } catch (error) {
            // Ignore errors if directory doesn't exist
            if (error.code !== 'ENOENT') {
                logger.error('DbBackupManager', 'Error cleaning up temp directory', {
                    error: error.message
                });
            }
        }
    }
}

module.exports = DbBackupManager;
