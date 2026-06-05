const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorizeMinRole } = require('../middleware/rbac');
const {
  getAppointments, getStatusCounts, getAppointment,
  checkConflicts, approveSchedule, proposeReschedule,
  clientConfirm, clientDecline, clientRequestChange,
  getAvailability, cancelAppointment, editAppointment,
} = require('../controllers/appointmentController');

router.use(authenticate);

// Literal paths first
router.get('/counts',           getStatusCounts);
router.get('/check-conflicts',  authorizeMinRole('psychometrician'), checkConflicts);
router.get('/availability',     getAvailability);

// CRUD
router.get('/',                 getAppointments);
router.get('/:id',              getAppointment);

// Staff actions
router.put('/:id/approve',             authorizeMinRole('psychometrician'), approveSchedule);
router.put('/:id/propose-reschedule',   authorizeMinRole('psychometrician'), proposeReschedule);

// Client actions (any authenticated user)
router.put('/:id/confirm',             clientConfirm);
router.put('/:id/decline',             clientDecline);
router.put('/:id/request-change',      clientRequestChange);
router.put('/:id/cancel',              cancelAppointment);
router.put('/:id/edit',                editAppointment);

module.exports = router;
