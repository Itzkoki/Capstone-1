const express  = require('express');
const router   = express.Router();
const { register, login, verifyEmail, resendOtp, forgotPassword, resetPassword, verifyToken } = require('../controllers/authController');
const { registerRules, loginRules, verifyEmailRules, resendOtpRules, forgotPasswordRules, resetPasswordRules, handleValidation } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');

// GET /api/auth/verify-token
router.get('/verify-token', authenticate, verifyToken);

// POST /api/auth/register
router.post('/register', registerRules, handleValidation, register);

// POST /api/auth/login
router.post('/login', loginRules, handleValidation, login);

// POST /api/auth/verify-email
router.post('/verify-email', verifyEmailRules, handleValidation, verifyEmail);

// POST /api/auth/resend-otp
router.post('/resend-otp', resendOtpRules, handleValidation, resendOtp);

// POST /api/auth/forgot-password
router.post('/forgot-password', forgotPasswordRules, handleValidation, forgotPassword);

// POST /api/auth/reset-password
router.post('/reset-password', resetPasswordRules, handleValidation, resetPassword);

module.exports = router;
