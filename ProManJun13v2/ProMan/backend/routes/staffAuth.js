const express = require('express');
const router  = express.Router();
const { login } = require('../controllers/staffAuthController');
const { staffLoginRules, handleValidation } = require('../middleware/validate');
const { staffLoginLimiter } = require('../middleware/rateLimiter');

// POST /api/staff-auth/login
// Rate limiter runs first (per-IP), then validation, then the controller
// (which adds per-account lockout + enumeration-safe responses).
// NOTE: login-only — there is intentionally NO register route here.
router.post('/login', staffLoginLimiter, staffLoginRules, handleValidation, login);

module.exports = router;
