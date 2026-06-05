const TeleconferenceSession = require('../models/TeleconferenceSession');
const Meeting = require('../models/Meeting');
const User = require('../models/User');
const notificationService = require('../services/notificationService');
const db = require('../config/db');

// Twilio setup
const twilio = require('twilio');
const AccessToken = twilio.jwt.AccessToken;
const VideoGrant = AccessToken.VideoGrant;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET;

const isStaff = (role) => role && role !== 'client';

// ── POST /api/teleconference — create session ──
const createSession = async (req, res, next) => {
  try {
    const { title, client_id, additional_staff } = req.body;
    if (!title) {
      return res.status(400).json({ success: false, message: 'Session title is required.' });
    }
    if (!client_id) {
      return res.status(400).json({ success: false, message: 'Assigning a client is required to create a session.' });
    }

    // Create the meeting record first
    const meeting = await Meeting.create(req.user.id, title);

    // Create Twilio room name
    const roomName = `barcarse-session-${meeting.id}-${Date.now()}`;

    // Create the teleconference session
    const session = await TeleconferenceSession.create({
      meetingId: meeting.id,
      psychologistId: req.user.id,
      clientId: client_id,
      twilioRoomSid: null,
      twilioRoomName: roomName,
    });

    // Log session creation
    await TeleconferenceSession.addLog(session.id, 'session_created', req.user.id, `Session "${title}" created`);

    // Notify client if assigned
    if (client_id) {
      try {
        await notificationService.notifyUser(
          client_id, 'teleconference',
          'New Consultation Session',
          `You have been invited to a teleconference session: "${title}". Please join when the session starts.`,
          'meetings.html'
        );
      } catch (err) { console.error('Session notification failed:', err.message); }
    }

    // Notify additional staff if specified
    if (additional_staff && additional_staff.length > 0) {
      for (const staffId of additional_staff) {
        try {
          await notificationService.notifyUser(
            staffId, 'teleconference',
            'New Consultation Session',
            `You have been added as a participant in a teleconference session: "${title}".`,
            'meetings.html'
          );
        } catch (err) { console.error('Staff notification failed:', err.message); }
      }
    }

    // Fetch full session with names
    const fullSession = await TeleconferenceSession.findById(session.id);

    return res.status(201).json({ success: true, data: fullSession });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/my-sessions — user's sessions ──
const getMySessions = async (req, res, next) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    const sessions = await TeleconferenceSession.findByParticipant(req.user.id, {
      status, limit: parseInt(limit), offset: parseInt(offset),
    });
    return res.json({ success: true, data: sessions });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference — all sessions (staff) ──
const getAllSessions = async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    let sessions;
    if (isStaff(req.user.role)) {
      sessions = await TeleconferenceSession.findAll({
        status, limit: parseInt(limit), offset: parseInt(offset),
      });
    } else {
      sessions = await TeleconferenceSession.findByParticipant(req.user.id, {
        status, limit: parseInt(limit), offset: parseInt(offset),
      });
    }
    return res.json({ success: true, data: sessions });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/:id — session detail ──
const getSession = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Access check: only participants or staff
    if (!isStaff(req.user.role) &&
        session.psychologist_id !== req.user.id &&
        session.client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    return res.json({ success: true, data: session });
  } catch (error) { next(error); }
};

// ── POST /api/teleconference/:id/join — join session & get Twilio token ──
const joinSession = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Access check
    if (session.psychologist_id !== req.user.id && session.client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'You are not a participant of this session.' });
    }

    if (session.session_status === 'ended' || session.session_status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'This session has already ended.' });
    }

    // Update status to active if scheduled
    if (session.session_status === 'scheduled') {
      await TeleconferenceSession.updateStatus(session.id, 'active');
    }

    // Generate Twilio access token for this participant
    const user = await User.findById(req.user.id);
    const identity = user ? user.full_name : `User-${req.user.id}`;

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_SECRET,
      { identity, ttl: 14400 } // 4 hours
    );

    const videoGrant = new VideoGrant({
      room: session.twilio_room_name,
    });
    token.addGrant(videoGrant);

    // Log join event
    await TeleconferenceSession.addLog(
      session.id, 'participant_joined', req.user.id,
      `${identity} (${req.user.role}) joined the session`
    );

    return res.json({
      success: true,
      data: {
        token: token.toJwt(),
        roomName: session.twilio_room_name,
        identity,
        session,
      },
    });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/start-recording — psychologist starts recording ──
const startRecording = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    if (session.psychologist_id !== req.user.id && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the psychologist can start recording.' });
    }

    const updated = await TeleconferenceSession.startRecording(session.id);

    await TeleconferenceSession.addLog(
      session.id, 'recording_requested', req.user.id,
      'Psychologist requested recording. Waiting for client consent.'
    );

    // Notify client about recording request
    if (session.client_id) {
      try {
        await notificationService.notifyUser(
          session.client_id, 'teleconference',
          'Recording Request',
          'The psychologist has requested to record this consultation session. Please provide your consent.',
          'meetings.html'
        );
      } catch (err) { console.error('Recording notification failed:', err.message); }
    }

    return res.json({ success: true, message: 'Recording requested. Awaiting client consent.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/consent-recording — client grants/denies consent ──
const consentRecording = async (req, res, next) => {
  try {
    const { consent } = req.body;
    if (consent === undefined) {
      return res.status(400).json({ success: false, message: 'consent (true/false) is required.' });
    }

    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Only client or staff can give consent
    if (session.client_id !== req.user.id && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the client can provide recording consent.' });
    }

    const updated = await TeleconferenceSession.setRecordingConsent(session.id, consent);

    await TeleconferenceSession.addLog(
      session.id, consent ? 'recording_consented' : 'recording_denied', req.user.id,
      consent ? 'Client consented to recording.' : 'Client denied recording.'
    );

    return res.json({
      success: true,
      message: consent ? 'Recording consent granted.' : 'Recording consent denied.',
      data: updated,
    });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/end — end session ──
const endSession = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Only psychologist or staff can end
    if (session.psychologist_id !== req.user.id && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the psychologist can end the session.' });
    }

    const updated = await TeleconferenceSession.updateStatus(session.id, 'ended');

    // Also end the linked meeting if active
    if (session.meeting_id) {
      try { await Meeting.endMeeting(session.meeting_id); } catch (e) {}
    }

    await TeleconferenceSession.addLog(
      session.id, 'session_ended', req.user.id,
      'Session ended by psychologist.'
    );

    return res.json({ success: true, message: 'Session ended.', data: updated });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/:id/logs — session audit trail (staff only) ──
const getSessionLogs = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    const logs = await TeleconferenceSession.getLogs(session.id);
    return res.json({ success: true, data: logs });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/assign-client — assign a client to a session ──
const assignClient = async (req, res, next) => {
  try {
    const { client_id } = req.body;
    if (!client_id) {
      return res.status(400).json({ success: false, message: 'client_id is required.' });
    }

    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    const db = require('../config/db');
    const result = await db.query(
      `UPDATE teleconference_sessions SET client_id = $1 WHERE id = $2 RETURNING *`,
      [client_id, session.id]
    );

    await TeleconferenceSession.addLog(
      session.id, 'client_assigned', req.user.id,
      `Client ID ${client_id} assigned to session.`
    );

    // Notify the client
    try {
      await notificationService.notifyUser(
        client_id, 'teleconference',
        'Consultation Session Invitation',
        `You have been invited to a consultation session. Please visit the meetings page to join.`,
        'meetings.html'
      );
    } catch (err) { console.error('Assignment notification failed:', err.message); }

    const updated = await TeleconferenceSession.findById(session.id);
    return res.json({ success: true, data: updated });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/clients — list clients for assignment ──
const getClients = async (req, res, next) => {
  try {
    const clients = await User.findByRole('client');
    return res.json({ success: true, data: clients });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/staff — list staff for assignment ──
const getStaffList = async (req, res, next) => {
  try {
    const allUsers = await db.query(
      `SELECT id, full_name, email, role FROM users WHERE role != 'client' ORDER BY full_name`
    );
    return res.json({ success: true, data: allUsers.rows });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/stop-recording — stop recording ──
const stopRecording = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    if (!isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only staff can stop recording.' });
    }

    await db.query(
      `UPDATE teleconference_sessions SET recording_enabled = false, recording_consent_given = false WHERE id = $1`,
      [session.id]
    );

    await TeleconferenceSession.addLog(
      session.id, 'recording_stopped', req.user.id,
      'Recording stopped by psychologist.'
    );

    return res.json({ success: true, message: 'Recording stopped.' });
  } catch (error) { next(error); }
};

module.exports = {
  createSession, getMySessions, getAllSessions, getSession,
  joinSession, startRecording, consentRecording, endSession,
  getSessionLogs, assignClient, getClients, getStaffList, stopRecording,
};
