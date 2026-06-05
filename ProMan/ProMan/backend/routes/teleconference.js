const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorizeMinRole } = require('../middleware/rbac');
const {
  createSession, getMySessions, getAllSessions, getSession,
  joinSession, startRecording, consentRecording, endSession,
  getSessionLogs, assignClient, getClients, getStaffList, stopRecording,
} = require('../controllers/teleconferenceController');

router.use(authenticate);

// Literal paths first
router.get('/my-sessions', getMySessions);
router.get('/clients',     authorizeMinRole('psychometrician'), getClients);
router.get('/staff',       authorizeMinRole('psychometrician'), getStaffList);

// CRUD
router.get('/',                         getAllSessions);
router.post('/',                        authorizeMinRole('psychometrician'), createSession);

// Param routes
router.get('/:id',                      getSession);
router.post('/:id/join',                joinSession);
router.put('/:id/start-recording',      authorizeMinRole('psychometrician'), startRecording);
router.put('/:id/stop-recording',       authorizeMinRole('psychometrician'), stopRecording);
router.put('/:id/consent-recording',    consentRecording);
router.put('/:id/end',                  authorizeMinRole('psychometrician'), endSession);
router.get('/:id/logs',                 authorizeMinRole('psychometrician'), getSessionLogs);
router.put('/:id/assign-client',        authorizeMinRole('psychometrician'), assignClient);

module.exports = router;
