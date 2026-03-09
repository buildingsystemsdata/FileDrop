require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { validatePin } = require('../utils/security');
const logger = require('../utils/logger');
const { resolveIpEntries, buildIpBlockList } = require('../utils/ipAllowlist');

const DEFAULT_SITE_TITLE = 'File Upload';
const DEFAULT_CLIENT_MAX_RETRIES = 5;

const logConfig = (message, level = 'info') => {
  const prefix = level === 'warning' ? '⚠️ WARNING:' : 'ℹ️ INFO:';
  console.log(`${prefix} CONFIGURATION: ${message}`);
};

const logAndReturn = (key, value, isDefault = false) => {
  logConfig(`${key}: ${value}${isDefault ? ' (default)' : ''}`);
  return value;
};

function determineUploadDirectory() {
  let uploadDir;

  if (process.env.NODE_ENV === 'test' && process.env.LOCAL_UPLOAD_DIR) {
    uploadDir = process.env.LOCAL_UPLOAD_DIR;
    logConfig(`Upload directory using LOCAL_UPLOAD_DIR for test environment: ${uploadDir}`);
  } else if (process.env.UPLOAD_DIR) {
    uploadDir = process.env.UPLOAD_DIR;
    logConfig(`Upload directory set from UPLOAD_DIR: ${uploadDir}`);
  } else if (process.env.LOCAL_UPLOAD_DIR) {
    uploadDir = process.env.LOCAL_UPLOAD_DIR;
    logConfig(`Upload directory using LOCAL_UPLOAD_DIR fallback: ${uploadDir}`, 'warning');
  } else {
    uploadDir = './local_uploads';
    logConfig(`Upload directory using default fallback: ${uploadDir}`, 'warning');
  }

  logConfig(`Final upload directory path: ${path.resolve(uploadDir)}`);
  return uploadDir;
}

function isLocalDevelopment() {
  return (process.env.NODE_ENV || 'production') !== 'production';
}

function ensureLocalUploadDirExists(uploadDir) {
  if (!isLocalDevelopment()) return;

  try {
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
      logConfig(`Created local upload directory: ${uploadDir}`);
    } else {
      logConfig(`Local upload directory exists: ${uploadDir}`);
    }
  } catch (err) {
    logConfig(`Failed to create local upload directory: ${uploadDir}. Error: ${err.message}`, 'warning');
  }
}

function resolvePinFromEnv() {
  return validatePin(process.env.DUMBDROP_PIN || process.env.PIN);
}

function buildIpAccessConfig() {
  const trustedProxyIps = resolveIpEntries({
    inlineEntries: process.env.TRUSTED_PROXY_IPS,
    fileEntries: process.env.TRUSTED_PROXY_IP_FILES,
  });
  const allowedSourceIps = resolveIpEntries({
    inlineEntries: process.env.ALLOWED_SOURCE_IPS,
    fileEntries: process.env.ALLOWED_SOURCE_IP_FILES,
  });

  return {
    trustedProxyIps: trustedProxyIps.length > 0 ? trustedProxyIps : null,
    trustedProxyBlockList: buildIpBlockList(trustedProxyIps),
    restrictToAllowedSourceIps: process.env.RESTRICT_TO_ALLOWED_SOURCE_IPS === 'true',
    allowedSourceIps: allowedSourceIps.length > 0 ? allowedSourceIps : null,
    allowedSourceBlockList: buildIpBlockList(allowedSourceIps),
  };
}

function buildConfig() {
  const port = process.env.PORT || 3000;
  const nodeEnv = process.env.NODE_ENV || 'production';
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  const uploadDir = determineUploadDirectory();

  ensureLocalUploadDirExists(uploadDir);

  const maxFileSize = (() => {
    const sizeInMB = parseInt(process.env.MAX_FILE_SIZE || '1024', 10);
    if (isNaN(sizeInMB) || sizeInMB <= 0) {
      throw new Error('MAX_FILE_SIZE must be a positive number');
    }
    return sizeInMB * 1024 * 1024;
  })();

  const clientMaxRetries = (() => {
    const envValue = process.env.CLIENT_MAX_RETRIES;
    if (envValue === undefined) {
      return logAndReturn('CLIENT_MAX_RETRIES', DEFAULT_CLIENT_MAX_RETRIES, true);
    }

    const retries = parseInt(envValue, 10);
    if (isNaN(retries) || retries < 0) {
      logConfig(
        `Invalid CLIENT_MAX_RETRIES value: "${envValue}". Using default: ${DEFAULT_CLIENT_MAX_RETRIES}`,
        'warning',
      );
      return logAndReturn('CLIENT_MAX_RETRIES', DEFAULT_CLIENT_MAX_RETRIES, true);
    }

    return logAndReturn('CLIENT_MAX_RETRIES', retries);
  })();

  const ipAccessConfig = buildIpAccessConfig();

  return {
    port,
    nodeEnv,
    baseUrl,
    uploadDir,
    maxFileSize,
    autoUpload: process.env.AUTO_UPLOAD === 'true',
    showFileList: process.env.SHOW_FILE_LIST === 'true',
    pin: resolvePinFromEnv(),
    trustProxy: process.env.TRUST_PROXY === 'true',
    trustedProxyIps: ipAccessConfig.trustedProxyIps,
    trustedProxyBlockList: ipAccessConfig.trustedProxyBlockList,
    restrictToAllowedSourceIps: ipAccessConfig.restrictToAllowedSourceIps,
    allowedSourceIps: ipAccessConfig.allowedSourceIps,
    allowedSourceBlockList: ipAccessConfig.allowedSourceBlockList,
    siteTitle: process.env.DUMBDROP_TITLE || DEFAULT_SITE_TITLE,
    appriseUrl: process.env.APPRISE_URL,
    appriseMessage: process.env.APPRISE_MESSAGE || 'New file uploaded - {filename} ({size}), Storage used {storage}',
    appriseSizeUnit: process.env.APPRISE_SIZE_UNIT,
    notificationWebhookUrl: process.env.NOTIFICATION_WEBHOOK_URL,
    notificationWebhookBearerToken: process.env.NOTIFICATION_WEBHOOK_BEARER_TOKEN,
    allowedExtensions: process.env.ALLOWED_EXTENSIONS
      ? process.env.ALLOWED_EXTENSIONS.split(',').map(ext => ext.trim().toLowerCase())
      : null,
    clientMaxRetries,
    uploadPin: logAndReturn('UPLOAD_PIN', process.env.UPLOAD_PIN || null),
  };
}

const config = {};

function refreshConfig() {
  console.log('Loaded ENV:', {
    PORT: process.env.PORT || 3000,
    UPLOAD_DIR: process.env.UPLOAD_DIR,
    LOCAL_UPLOAD_DIR: process.env.LOCAL_UPLOAD_DIR,
    NODE_ENV: process.env.NODE_ENV || 'production',
    BASE_URL: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',
  });

  Object.assign(config, buildConfig());
  console.log(`Upload directory configured as: ${config.uploadDir}`);
  return config;
}

function validateConfig() {
  const errors = [];

  if (config.maxFileSize <= 0) {
    errors.push('MAX_FILE_SIZE must be greater than 0');
  }

  try {
    if (!config.baseUrl.endsWith('/')) {
      logger.warn('BASE_URL did not end with a trailing slash. Automatically appending "/".');
      config.baseUrl = config.baseUrl + '/';
    }
  } catch (err) {
    const errorMsg = `BASE_URL must be a valid URL: ${err.message || err}`;
    logger.error(errorMsg);
    errors.push(errorMsg);
  }

  if (config.nodeEnv === 'production' && !config.appriseUrl && !config.notificationWebhookUrl) {
    logger.info('Notifications disabled - No Configuration');
  }

  if (errors.length > 0) {
    throw new Error('Configuration validation failed:\n' + errors.join('\n'));
  }
}

refreshConfig();

module.exports = {
  config,
  refreshConfig,
  validateConfig,
};
