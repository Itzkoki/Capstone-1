const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorizeMinRole } = require('../middleware/rbac');
const {
  createSession, getMySessions, getAllSessions, getSession, pollSession,
  joinSession, redeemInvite, heartbeat, reconnectSession, admitParticipant, removeParticipant, leaveSession,
  startRecording, consentRecording, endSession,
  getSessionLogs, getMessages, postMessage, assignClient, getClients, getStaffList, stopRecording,
} = require('../controllers/teleconferenceController');
const { sendOtp, verifyOtp } = require('../controllers/teleconfOtpController');

router.use(authenticate);

// OTP endpoints (literal, must come before param routes)
router.post('/otp/send',   sendOtp);
router.post('/otp/verify', verifyOtp);

// Single-use invitation redemption (literal, before param routes)
router.post('/invite/redeem', redeemInvite);

// Literal paths first
router.get('/my-sessions', getMySessions);
router.get('/clients',     authorizeMinRole('psychometrician'), getClients);
router.get('/staff',       authorizeMinRole('psychometrician'), getStaffList);

// CRUD
router.get('/',                         getAllSessions);
router.post('/',                        authorizeMinRole('psychometrician'), createSession);

// Param routes
router.get('/:id',                      getSession);
router.get('/:id/poll',                 pollSession);
router.post('/:id/join',                joinSession);
router.post('/:id/heartbeat',           heartbeat);
router.post('/:id/reconnect',           reconnectSession);
router.put('/:id/admit',                authorizeMinRole('psychometrician'), admitParticipant);
router.put('/:id/remove',               authorizeMinRole('psychometrician'), removeParticipant);
router.post('/:id/leave',               leaveSession);
router.put('/:id/start-recording',      authorizeMinRole('psychometrician'), startRecording);
router.put('/:id/stop-recording',       authorizeMinRole('psychometrician'), stopRecording);
router.put('/:id/consent-recording',    consentRecording);
router.put('/:id/end',                  authorizeMinRole('psychometrician'), endSession);
router.get('/:id/logs',                 authorizeMinRole('psychometrician'), getSessionLogs);
router.get('/:id/messages',             getMessages);
router.post('/:id/messages',            postMessage);
router.put('/:id/assign-client',        authorizeMinRole('psychometrician'), assignClient);

module.exports = router;
