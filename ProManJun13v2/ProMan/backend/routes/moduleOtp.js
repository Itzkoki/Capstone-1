const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { sendOtp, verifyOtp } = require('../controllers/moduleOtpController');

router.use(authenticate);

// Email-OTP gate for sensitive staff-only modules.
router.post('/send',   sendOtp);
router.post('/verify', verifyOtp);

module.exports = router;
