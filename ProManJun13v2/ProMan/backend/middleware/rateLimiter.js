const rateLimit = require('express-rate-limit');

/**
 * Per-IP rate limiter for the staff login endpoint.
 *
 * Policy: at most 5 *failed* attempts per IP within a 15-minute window.
 * Successful logins (2xx responses) are never counted — only bad-password /
 * error responses are. Exceeding the limit returns HTTP 429.
 * The controller adds a second, per-account lockout (see LoginAttempt).
 *
 * NOTE: requires `app.set('trust proxy', 1)` in server.js so the limiter keys
 * off the real client IP when running behind AWS load-balancer / reverse-proxy
 * infrastructure rather than the proxy's address.
 *
 * Loopback addresses (localhost) are skipped: during local development /
 * testing every account shares 127.0.0.1, so without this a few bad passwords
 * spread across different test accounts would trip the shared-IP counter and
 * lock out unrelated accounts. Per-account lockout (see LoginAttempt) still
 * applies on localhost. In production each client presents its real IP.
 */
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const staffLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,      // 15 minutes
  max: 5,                         // 5 *failed* attempts per IP per window
  skipSuccessfulRequests: true,   // successful logins do NOT count
  skip: (req) => LOOPBACK_IPS.has(req.ip),  // never rate-limit localhost
  standardHeaders: true,          // emit RateLimit-* headers
  legacyHeaders: false,           // disable X-RateLimit-* headers
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many login attempts. Please try again later.',
    });
  },
});

/**
 * Per-IP rate limiter for the CAPTCHA verification endpoint.
 *
 * Each call hits Google's siteverify API and (on a low v3 score) can escalate
 * to a v2 challenge, so we throttle to stop token-farming / brute-forcing the
 * verification flow. Policy: at most 30 verification attempts per IP per
 * 10-minute window (override with CAPTCHA_RATE_LIMIT_MAX). ALL attempts count
 * — a successful verification shouldn't refill the bucket for an attacker.
 *
 * Unlike the login limiter this does NOT skip loopback: normal browsing only
 * triggers a handful of verifications, so the generous limit won't hinder local
 * development while still being demonstrably enforced.
 */
const captchaVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,                              // 10 minutes
  max: Number(process.env.CAPTCHA_RATE_LIMIT_MAX) || 30, // attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many verification attempts. Please wait a few minutes and try again.',
    });
  },
});

/**
 * Per-IP rate limiter for login OTP verification (second factor).
 *
 * The OTP is the second authentication factor: a 6-digit code has only
 * 1,000,000 combinations, so without a cap an attacker who already passed the
 * password step could brute-force the active code. Policy: at most 10 *failed*
 * verification attempts per IP within a 15-minute window; exceeding it returns
 * HTTP 429. Successful verifications (2xx) are never counted, so a legitimate
 * user mistyping the code a few times is unaffected. This is defense-in-depth
 * alongside the ~2-minute OTP expiry.
 *
 * Kept separate from staffLoginLimiter so client-OTP checks and staff logins
 * don't share one bucket. Loopback is skipped for the same reason as the login
 * limiter: during local testing every account shares 127.0.0.1.
 */
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,      // 15 minutes
  max: 10,                        // 10 *failed* attempts per IP per window
  skipSuccessfulRequests: true,   // a correct OTP does NOT count
  skip: (req) => LOOPBACK_IPS.has(req.ip),  // never rate-limit localhost
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many attempts. Please request a new code and try again later.',
    });
  },
});

/**
 * Per-IP rate limiter for the public Contact Us form.
 * Policy: at most 5 submissions per IP per 15-minute window to curb spam.
 */
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many messages sent. Please wait a few minutes and try again.',
    });
  },
});

module.exports = { staffLoginLimiter, captchaVerifyLimiter, otpVerifyLimiter, contactLimiter };
