const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const { login, verifyOtp, resendOtp } = require('../controllers/staffAuthController');
const { staffLoginRules, handleValidation } = require('../middleware/validate');
const { staffLoginLimiter } = require('../middleware/rateLimiter');

// POST /api/staff-auth/login  — step 1: username + password → emails an OTP.
// Rate limiter runs first (per-IP), then validation, then the controller
// (which adds per-account lockout + enumeration-safe responses).
// NOTE: login-only — there is intentionally NO register route here.
router.post('/login', staffLoginLimiter, staffLoginRules, handleValidation, login);

// POST /api/staff-auth/verify-otp — step 2: confirm the emailed code → JWT.
const verifyOtpRules = [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('otp').trim().notEmpty().withMessage('Verification code is required')
    .isLength({ min: 6, max: 6 }).withMessage('Enter the 6-digit code')
    .isNumeric().withMessage('The code is numeric'),
];
router.post('/verify-otp', verifyOtpRules, handleValidation, verifyOtp);

// POST /api/staff-auth/resend-otp — re-send a code for an in-progress login.
const resendRules = [body('username').trim().notEmpty().withMessage('Username is required')];
router.post('/resend-otp', resendRules, handleValidation, resendOtp);

module.exports = router;
