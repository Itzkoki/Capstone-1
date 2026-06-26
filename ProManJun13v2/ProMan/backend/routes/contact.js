const express = require('express');
const router  = express.Router();
const { contactLimiter } = require('../middleware/rateLimiter');
const { submitContactMessage } = require('../controllers/contactController');

// Public endpoint — no authentication required for the marketing contact form.
router.post('/', contactLimiter, submitContactMessage);

module.exports = router;
