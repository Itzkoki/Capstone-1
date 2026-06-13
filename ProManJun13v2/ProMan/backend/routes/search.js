const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { search } = require('../controllers/searchController');

router.use(authenticate);
router.get('/', search);

module.exports = router;
