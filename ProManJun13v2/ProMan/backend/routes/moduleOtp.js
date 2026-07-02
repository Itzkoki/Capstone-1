const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { otpVerifyLimiter } = require('../middleware/rateLimiter');
const { sendOtp, verifyOtp } = require('../controllers/moduleOtpController');

router.use(authenticate);

// Email-OTP gate for sensitive staff-only modules.
router.post('/send',   sendOtp);
// Rate-limited (per IP) so the module-gate code can't be brute-forced.
router.post('/verify', otpVerifyLimiter, verifyOtp);

module.exports = router;
