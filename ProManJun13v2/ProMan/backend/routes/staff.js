const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');
const { staffCreateRules, handleValidation } = require('../middleware/validate');
const {
  getAllStaff,
  getStaffById,
  createStaff,
  updateStaffRole,
  setStaffStatus,
  getActivityLogs,
  getStaffActivity,
} = require('../controllers/staffController');

// All staff-management routes require authentication + clinical_director role.
router.use(authenticate);
router.use(authorize('clinical_director'));

router.get('/',               getAllStaff);
router.get('/activity-logs',  getActivityLogs);
router.get('/:id',            getStaffById);
router.get('/:id/activity',   getStaffActivity);

// Internal account creation (no public registration).
router.post('/',              staffCreateRules, handleValidation, createStaff);

router.put('/:id/role',       updateStaffRole);
router.patch('/:id/status',   setStaffStatus);

module.exports = router;
