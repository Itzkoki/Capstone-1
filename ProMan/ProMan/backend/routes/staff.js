const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');
const { getAllStaff, getStaffById, updateStaffRole, deactivateStaff, getActivityLogs, getStaffActivity } = require('../controllers/staffController');

// All staff routes require authentication + clinical_director role
router.use(authenticate);
router.use(authorize('clinical_director'));

router.get('/',               getAllStaff);
router.get('/activity-logs',  getActivityLogs);
router.get('/:id',            getStaffById);
router.get('/:id/activity',   getStaffActivity);
router.put('/:id/role',       updateStaffRole);
router.delete('/:id',         deactivateStaff);

module.exports = router;
