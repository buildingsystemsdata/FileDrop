const fs = require('fs');
const path = require('path');
const net = require('net');
const { BlockList } = require('node:net');

const logger = require('./logger');

function normalizeIp(ip) {
  if (!ip) return 'unknown';

  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }

  return ip;
}

function getIpType(ip) {
  const normalizedIp = normalizeIp(ip);
  const family = net.isIP(normalizedIp);

  if (family === 4) return 'ipv4';
  if (family === 6) return 'ipv6';

  return null;
}

function parseInlineEntries(rawValue) {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function loadEntriesFromFiles(rawFileList) {
  const filePaths = parseInlineEntries(rawFileList);
  const entries = [];

  for (const filePath of filePaths) {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      logger.warn(`IP allowlist file not found: ${resolvedPath}`);
      continue;
    }

    const fileEntries = fs
      .readFileSync(resolvedPath, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));

    entries.push(...fileEntries);
  }

  return entries;
}

function resolveIpEntries({ inlineEntries, fileEntries }) {
  return [...new Set([...parseInlineEntries(inlineEntries), ...loadEntriesFromFiles(fileEntries)])];
}

function buildIpBlockList(entries) {
  if (!entries || entries.length === 0) {
    return null;
  }

  const blockList = new BlockList();
  let hasEntries = false;

  for (const entry of entries) {
    const normalizedEntry = normalizeIp(entry);

    if (!normalizedEntry || normalizedEntry === 'unknown') {
      continue;
    }

    if (normalizedEntry.includes('/')) {
      const [network, prefixLengthRaw] = normalizedEntry.split('/');
      const type = getIpType(network);
      const prefixLength = Number.parseInt(prefixLengthRaw, 10);

      if (!type || Number.isNaN(prefixLength)) {
        logger.warn(`Skipping invalid IP subnet entry: ${entry}`);
        continue;
      }

      blockList.addSubnet(network, prefixLength, type);
      hasEntries = true;
      continue;
    }

    const type = getIpType(normalizedEntry);
    if (!type) {
      logger.warn(`Skipping invalid IP entry: ${entry}`);
      continue;
    }

    blockList.addAddress(normalizedEntry, type);
    hasEntries = true;
  }

  return hasEntries ? blockList : null;
}

function isIpAllowed(ip, blockList) {
  if (!blockList) {
    return false;
  }

  const normalizedIp = normalizeIp(ip);
  const type = getIpType(normalizedIp);

  if (!type) {
    return false;
  }

  return blockList.check(normalizedIp, type);
}

module.exports = {
  normalizeIp,
  resolveIpEntries,
  buildIpBlockList,
  isIpAllowed,
};
