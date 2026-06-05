const ActivityLog = require('../models/ActivityLog');

/**
 * Helper: get client IP from request.
 */
const getClientIP = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.connection?.remoteAddress
    || req.ip
    || 'unknown';
};

/**
 * Middleware that auto-logs mutating requests (POST, PUT, DELETE).
 * Attach after authenticate middleware so req.user is available.
 */
const activityLogger = (req, res, next) => {
  // Only log mutating methods
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return next();
  }

  // Store original json method to intercept response
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    // Log activity after response is sent (non-blocking)
    const userId = req.user?.id || null;
    const action = `${req.method} ${req.originalUrl}`;
    const ipAddress = getClientIP(req);

    // Determine resource type from URL
    const urlParts = req.originalUrl.split('/').filter(Boolean);
    const resourceType = urlParts[1] || 'unknown'; // e.g. 'auth', 'profile', 'staff'

    // Don't log passwords or sensitive data
    const safeBody = { ...req.body };
    delete safeBody.password;
    delete safeBody.current_password;
    delete safeBody.new_password;
    delete safeBody.token;

    ActivityLog.log(userId, action, resourceType, null, ipAddress, {
      statusCode: res.statusCode,
      body: Object.keys(safeBody).length > 0 ? safeBody : undefined,
    }).catch(err => {
      console.error('⚠️  Activity log failed:', err.message);
    });

    return originalJson(body);
  };

  next();
};

module.exports = { activityLogger };
