const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');
const { getSystemSettings, updateSystemSettings, getSystemHealth } = require('../controllers/systemController');

router.use(authenticate);
router.use(authorize('clinical_director'));

router.get('/settings',    getSystemSettings);
router.put('/settings',    updateSystemSettings);
router.get('/health',      getSystemHealth);

module.exports = router;
