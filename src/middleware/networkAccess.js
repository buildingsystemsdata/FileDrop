const { config } = require('../config');
const logger = require('../utils/logger');
const { normalizeIp, isIpAllowed } = require('../utils/ipAllowlist');

function restrictSourceIps(req, res, next) {
  if (!config.restrictToAllowedSourceIps) {
    return next();
  }

  if (!config.allowedSourceBlockList) {
    logger.warn('Source IP restriction enabled but no allowed source IPs are configured');
    return res.status(503).json({ error: 'Source IP allowlist is not configured' });
  }

  const sourceIp = normalizeIp(req.socket.remoteAddress || req.connection.remoteAddress || req.ip || 'unknown');

  if (isIpAllowed(sourceIp, config.allowedSourceBlockList)) {
    return next();
  }

  logger.warn(`Blocked request from non-allowlisted source IP: ${sourceIp}`);
  return res.status(403).json({ error: 'Forbidden' });
}

module.exports = {
  restrictSourceIps,
};
