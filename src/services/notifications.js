/**
 * Notification service for file upload events.
 * Integrates with Apprise and direct webhooks for upload notifications.
 */

const { spawn } = require('child_process');
const path = require('path');

const { formatFileSize, calculateDirectorySize, sanitizeFilename } = require('../utils/fileUtils');
const logger = require('../utils/logger');

const DEFAULT_NOTIFICATION_BATCH_DELAY_MS = 2000;
const pendingBatchNotifications = new Map();

function normalizeStoredPath(storedPath) {
  if (!storedPath) {
    return null;
  }

  return storedPath.replace(/\\/g, '/');
}

function buildNotificationFileEntry(notification, config) {
  const sanitizedFilename = sanitizeFilename(notification.filename);
  const uploadedAt = notification.completedAt || Date.now();

  return {
    uploadId: notification.uploadId || null,
    filename: sanitizedFilename,
    originalFilename: notification.filename,
    storedPath: normalizeStoredPath(notification.storedPath),
    fileSize: notification.fileSize,
    formattedSize: formatFileSize(notification.fileSize, config.appriseSizeUnit),
    uploadedAt: new Date(uploadedAt).toISOString(),
    isZeroByte: notification.fileSize === 0,
  };
}

function buildNotificationPayload(batchNotification, config, totalStorage) {
  const files = [...batchNotification.files.values()].sort((left, right) => {
    return new Date(left.uploadedAt).getTime() - new Date(right.uploadedAt).getTime();
  });
  const latestFile = files[files.length - 1];
  const batchTotalSize = files.reduce((sum, file) => sum + file.fileSize, 0);
  const formattedBatchSize = formatFileSize(batchTotalSize, config.appriseSizeUnit);

  let message = config.appriseMessage
    .replace('{filename}', latestFile.filename)
    .replace('{size}', latestFile.formattedSize)
    .replace('{storage}', totalStorage);

  if (files.length > 1) {
    message = `New upload batch - ${files.length} files (${formattedBatchSize}), Storage used ${totalStorage}`;
  }

  return {
    message,
    payload: {
      event: 'upload.batch.completed',
      siteTitle: config.siteTitle,
      baseUrl: config.baseUrl,
      batchId: batchNotification.batchId,
      fileCount: files.length,
      batchTotalSize,
      formattedBatchSize,
      totalStorage,
      startedAt: new Date(batchNotification.startedAt).toISOString(),
      completedAt: new Date(batchNotification.lastUpdatedAt).toISOString(),
      latestFile,
      files,
      message,
    },
    latestFile,
    formattedBatchSize,
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

async function sendAppriseNotification(appriseUrl, message, latestFile, formattedBatchSize, totalStorage) {
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
        logger.info(
          `Notification sent for: ${latestFile.filename} (${formattedBatchSize}, Total storage: ${totalStorage})`,
        );
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

async function flushBatchNotification(batchId) {
  const batchNotification = pendingBatchNotifications.get(batchId);
  if (!batchNotification) {
    return;
  }

  pendingBatchNotifications.delete(batchId);

  const {
    config,
    appriseUrl,
    notificationWebhookUrl,
    notificationWebhookBearerToken,
    uploadDir,
  } = batchNotification;

  try {
    const dirSize = await calculateDirectorySize(uploadDir);
    const totalStorage = formatFileSize(dirSize, config.appriseSizeUnit);
    const { message, payload, latestFile, formattedBatchSize } = buildNotificationPayload(
      batchNotification,
      config,
      totalStorage,
    );

    if (notificationWebhookUrl) {
      await sendWebhookNotification(notificationWebhookUrl, payload, notificationWebhookBearerToken);
      logger.info(
        `Webhook notification sent for batch ${batchId} (${payload.fileCount} file(s), ${formattedBatchSize})`,
      );
    }

    if (appriseUrl) {
      await sendAppriseNotification(appriseUrl, message, latestFile, formattedBatchSize, totalStorage);
    }
  } catch (err) {
    logger.error(`Failed to send notification: ${err.message}`);
  }
}

function queueBatchNotification(notification, config) {
  const batchId = notification.batchId || notification.uploadId || `single-${Date.now()}`;
  const batchDelayMs = config.notificationBatchDelayMs || DEFAULT_NOTIFICATION_BATCH_DELAY_MS;

  let batchNotification = pendingBatchNotifications.get(batchId);
  if (!batchNotification) {
    batchNotification = {
      batchId,
      startedAt: notification.completedAt || Date.now(),
      lastUpdatedAt: notification.completedAt || Date.now(),
      files: new Map(),
      config,
      appriseUrl: config.appriseUrl,
      notificationWebhookUrl: config.notificationWebhookUrl,
      notificationWebhookBearerToken: config.notificationWebhookBearerToken,
      uploadDir: config.uploadDir,
      timer: null,
    };
    pendingBatchNotifications.set(batchId, batchNotification);
  }

  batchNotification.lastUpdatedAt = notification.completedAt || Date.now();
  const fileEntry = buildNotificationFileEntry(notification, config);
  const fileKey = notification.uploadId || `${fileEntry.storedPath || fileEntry.filename}-${fileEntry.uploadedAt}`;
  batchNotification.files.set(fileKey, fileEntry);

  if (batchNotification.timer) {
    clearTimeout(batchNotification.timer);
  }

  batchNotification.timer = setTimeout(() => {
    flushBatchNotification(batchId);
  }, batchDelayMs);
  batchNotification.timer.unref?.();
}

/**
 * Queue a notification for an uploaded file. Files sharing the same batch ID
 * are grouped into a single webhook payload after a short debounce window.
 *
 * @param {Object} notification
 * @param {Object} config
 * @returns {Promise<void>}
 */
async function sendNotification(notification, config) {
  const { appriseUrl, notificationWebhookUrl } = config;

  if (!appriseUrl && !notificationWebhookUrl) {
    return;
  }

  queueBatchNotification(notification, config);
}

function buildStoredPath(uploadDir, filePath) {
  return normalizeStoredPath(path.relative(uploadDir, filePath));
}

module.exports = {
  buildNotificationPayload,
  buildStoredPath,
  sendNotification,
};
