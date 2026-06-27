const express  = require('express');
const router   = express.Router();
const { register, login, verifyEmail, resendOtp, verifyLoginOtp, resendLoginOtp, forgotPassword, resetPassword, forceResetPassword, verifyToken, logout } = require('../controllers/authController');
const { registerRules, loginRules, verifyEmailRules, resendOtpRules, forgotPasswordRules, resetPasswordRules, handleValidation } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');

// GET /api/auth/verify-token
router.get('/verify-token', authenticate, verifyToken);

// POST /api/auth/logout — revokes the caller's session server-side.
router.post('/logout', authenticate, logout);

// POST /api/auth/register
router.post('/register', registerRules, handleValidation, register);

// POST /api/auth/login
router.post('/login', loginRules, handleValidation, login);

// POST /api/auth/verify-email
router.post('/verify-email', verifyEmailRules, handleValidation, verifyEmail);

// POST /api/auth/resend-otp
router.post('/resend-otp', resendOtpRules, handleValidation, resendOtp);

// POST /api/auth/verify-login-otp — second factor on every client login
router.post('/verify-login-otp', verifyEmailRules, handleValidation, verifyLoginOtp);

// POST /api/auth/resend-login-otp — resend the login code (2-min cooldown)
router.post('/resend-login-otp', resendOtpRules, handleValidation, resendLoginOtp);

// POST /api/auth/forgot-password
router.post('/forgot-password', forgotPasswordRules, handleValidation, forgotPassword);

// POST /api/auth/reset-password
router.post('/reset-password', resetPasswordRules, handleValidation, resetPassword);

// POST /api/auth/force-reset-password — authenticated reset for a client flagged
// with must_reset_password (Action Center "Force Password Reset"). No email token.
router.post('/force-reset-password', authenticate, forceResetPassword);

module.exports = router;
