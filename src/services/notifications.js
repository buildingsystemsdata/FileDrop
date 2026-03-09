/**
 * Notification service for file upload events.
 * Integrates with Apprise for sending notifications about uploads.
 * Handles message formatting and notification delivery.
 */

const { spawn } = require('child_process');
const { formatFileSize, calculateDirectorySize, sanitizeFilename } = require('../utils/fileUtils');
const logger = require('../utils/logger');

function buildNotificationPayload(filename, fileSize, config, totalStorage) {
    const { appriseMessage, appriseSizeUnit } = config;
    const formattedSize = formatFileSize(fileSize, appriseSizeUnit);
    const sanitizedFilename = sanitizeFilename(filename);
    const message = appriseMessage
        .replace('{filename}', sanitizedFilename)
        .replace('{size}', formattedSize)
        .replace('{storage}', totalStorage);

    return {
        sanitizedFilename,
        formattedSize,
        message,
        payload: {
            filename: sanitizedFilename,
            fileSize,
            formattedSize,
            totalStorage,
            message,
        },
    };
}

async function sendWebhookNotification(webhookUrl, payload, bearerToken) {
    const headers = {
        'content-type': 'application/json',
    };

    if (bearerToken) {
        headers.authorization = `Bearer ${bearerToken}`;
    }

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`Webhook request failed with status ${response.status}: ${responseBody}`);
    }
}

/**
 * Send a notification using Apprise
 * @param {string} filename - Name of uploaded file
 * @param {number} fileSize - Size of uploaded file in bytes
 * @param {Object} config - Configuration object
 * @returns {Promise<void>}
 */
async function sendNotification(filename, fileSize, config) {
    const { appriseUrl, notificationWebhookUrl, notificationWebhookBearerToken, uploadDir } = config;

    if (!appriseUrl && !notificationWebhookUrl) {
        return;
    }

    try {
        const dirSize = await calculateDirectorySize(uploadDir);
        const totalStorage = formatFileSize(dirSize);
        const { sanitizedFilename, formattedSize, message, payload } = buildNotificationPayload(
            filename,
            fileSize,
            config,
            totalStorage,
        );

        if (notificationWebhookUrl) {
            await sendWebhookNotification(notificationWebhookUrl, payload, notificationWebhookBearerToken);
            logger.info(`Webhook notification sent for: ${sanitizedFilename} (${formattedSize}, Total storage: ${totalStorage})`);
        }

        if (appriseUrl) {
            await new Promise((resolve, reject) => {
                const appriseProcess = spawn('apprise', [appriseUrl, '-b', message]);

                appriseProcess.stdout.on('data', (data) => {
                    logger.info(`Apprise Output: ${data.toString().trim()}`);
                });

                appriseProcess.stderr.on('data', (data) => {
                    logger.error(`Apprise Error: ${data.toString().trim()}`);
                });

                appriseProcess.on('close', (code) => {
                    if (code === 0) {
                        logger.info(`Notification sent for: ${sanitizedFilename} (${formattedSize}, Total storage: ${totalStorage})`);
                        resolve();
                    } else {
                        reject(new Error(`Apprise process exited with code ${code}`));
                    }
                });

                appriseProcess.on('error', (err) => {
                    reject(new Error(`Apprise process failed to start: ${err.message}`));
                });
            });
        }
    } catch (err) {
        logger.error(`Failed to send notification: ${err.message}`);
    }
}

module.exports = {
    sendNotification,
};
