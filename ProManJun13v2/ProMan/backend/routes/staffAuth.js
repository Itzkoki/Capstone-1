const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const { login, verifyOtp, resendOtp, forgotPassword, resetPassword } = require('../controllers/staffAuthController');
const { staffLoginRules, forgotPasswordRules, resetPasswordRules, handleValidation } = require('../middleware/validate');
const { staffLoginLimiter, otpVerifyLimiter } = require('../middleware/rateLimiter');

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
// Rate-limited (per IP) so the staff second factor can't be brute-forced.
router.post('/verify-otp', otpVerifyLimiter, verifyOtpRules, handleValidation, verifyOtp);

// POST /api/staff-auth/resend-otp — re-send a code for an in-progress login.
const resendRules = [body('username').trim().notEmpty().withMessage('Username is required')];
router.post('/resend-otp', resendRules, handleValidation, resendOtp);

// POST /api/staff-auth/forgot-password — email a single-use reset link.
// Per-IP rate limited (reuses the staff-login limiter) so the endpoint can't be
// hammered to probe emails or spam mailboxes. Enumeration-safe response.
router.post('/forgot-password', staffLoginLimiter, forgotPasswordRules, handleValidation, forgotPassword);

// POST /api/staff-auth/reset-password — consume the token and set a new password.
router.post('/reset-password', resetPasswordRules, handleValidation, resetPassword);

module.exports = router;
