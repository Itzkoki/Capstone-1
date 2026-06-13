const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { getCommunityStats } = require('../controllers/communityController');

router.use(authenticate);

router.get('/stats', getCommunityStats);

module.exports = router;
