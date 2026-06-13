const rateLimit = require('express-rate-limit');

/**
 * Per-IP rate limiter for the staff login endpoint.
 *
 * Policy: at most 5 attempts per IP within a 15-minute window. Exceeding the
 * limit returns HTTP 429 with a generic message (no detail that could aid an
 * attacker). This is the first defence layer; the controller adds a second,
 * per-account lockout (see LoginAttempt).
 *
 * NOTE: requires `app.set('trust proxy', 1)` in server.js so the limiter keys
 * off the real client IP when running behind AWS load-balancer / reverse-proxy
 * infrastructure rather than the proxy's address.
 */
const staffLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                    // 5 attempts per IP per window
  standardHeaders: true,     // emit RateLimit-* headers
  legacyHeaders: false,      // disable X-RateLimit-* headers
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many login attempts. Please try again later.',
    });
  },
});

module.exports = { staffLoginLimiter };
