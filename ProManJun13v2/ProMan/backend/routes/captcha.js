const express = require('express');
const router  = express.Router();
const { verifyCaptcha, auditEvent, psychAccess } = require('../controllers/captchaController');
const { optionalAuthenticate, authenticate } = require('../middleware/auth');
const { captchaVerifyLimiter } = require('../middleware/rateLimiter');

// POST /api/captcha/verify — verify a reCAPTCHA v3 token, escalating to a v2
// challenge on a suspicious score (public, no auth needed; rate-limited per IP)
router.post('/verify', captchaVerifyLimiter, verifyCaptcha);

// POST /api/captcha/audit — log a front-end security event (auth optional)
router.post('/audit', optionalAuthenticate, auditEvent);

// POST /api/captcha/psych-access — staff only; validates clearance + logs psych reports access
router.post('/psych-access', authenticate, psychAccess);

module.exports = router;
