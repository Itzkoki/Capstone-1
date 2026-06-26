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
 * Map a raw "METHOD /api/path" action to a human-friendly Audit Logs label.
 * Falls back to a readable "Verb resource" form for anything unmapped.
 */
const friendlyAction = (method, originalUrl, resourceType, statusCode, ok) => {
  const url = (originalUrl || '').split('?')[0];

  // Authentication events get explicit, recognizable names.
  if (url.includes('/auth/verify-login-otp') || url.includes('/staff-auth/verify-login-otp')) {
    return ok ? 'Login' : 'Failed Login Attempt';
  }
  if (url.includes('/auth/login') || url.includes('/staff-auth/login')) {
    return ok ? 'Login (code sent)' : 'Failed Login Attempt';
  }
  if (url.includes('/profile/change-password')) return 'Password Changed';
  if (url.includes('/profile')) return 'Profile Updated';

  const verb = { POST: 'Created', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted' }[method] || method;
  const res = resourceType ? resourceType.replace(/-/g, ' ') : 'record';
  return `${verb} ${res}`;
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

  // Skip high-frequency / non-security noise so the Audit Logs stay meaningful
  // (e.g. teleconference heartbeats fire every few seconds per active call).
  const noisy = /\/heartbeat\b|\/captcha\/(audit|verify)\b/;
  if (noisy.test(req.originalUrl)) {
    return next();
  }

  // Store original json method to intercept response
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    // Log activity after response is sent (non-blocking)
    const userId = req.user?.id || null;
    const ipAddress = getClientIP(req);

    // Determine resource type from URL
    const urlParts = req.originalUrl.split('/').filter(Boolean);
    const resourceType = urlParts[1] || 'unknown'; // e.g. 'auth', 'profile', 'staff'

    // Success/Failed status drives the Audit Logs "Status" column.
    const ok = res.statusCode < 400 && (body == null || body.success !== false);
    const status = ok ? 'Success' : 'Failed';
    const action = friendlyAction(req.method, req.originalUrl, resourceType, res.statusCode, ok);

    // Don't log passwords or sensitive data
    const safeBody = { ...req.body };
    delete safeBody.password;
    delete safeBody.current_password;
    delete safeBody.new_password;
    delete safeBody.token;
    delete safeBody.otp;
    delete safeBody.captcha_clearance;

    ActivityLog.log(
      userId,
      action,
      resourceType,
      null,
      ipAddress,
      {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        statusCode: res.statusCode,
        body: Object.keys(safeBody).length > 0 ? safeBody : undefined,
      },
      {
        role: req.user?.role || null,
        status,
        userAgent: req.headers['user-agent'] || null,
        fingerprint: req.headers['x-device-fp'] || null,
      }
    ).catch(err => {
      console.error('⚠️  Activity log failed:', err.message);
    });

    return originalJson(body);
  };

  next();
};

module.exports = { activityLogger };
