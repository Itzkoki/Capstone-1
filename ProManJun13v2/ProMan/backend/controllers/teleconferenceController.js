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

// A user must have a VERIFIED account before they can be assigned to a
// teleconference. Returns { user } when eligible, or { error } with a message.
async function getEligibleClientOrError(clientId) {
  const client = await User.findById(clientId);
  if (!client) {
    return { error: 'The selected client could not be found.' };
  }
  if (!client.is_verified) {
    return {
      error: `${client.full_name || 'This client'} is not verified yet. Only verified users can be assigned to a teleconference.`,
    };
  }
  return { user: client };
}

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

    // Eligibility: the assigned client's account must be verified.
    const eligibility = await getEligibleClientOrError(client_id);
    if (eligibility.error) {
      return res.status(400).json({ success: false, message: eligibility.error });
    }

    const staffList = Array.isArray(additional_staff) ? additional_staff.filter(Boolean) : [];
    if (staffList.length > 3) {
      return res.status(400).json({ success: false, message: 'You can add up to 3 additional staff members.' });
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

    // ── Provision participants ──
    // Host (the creator) is auto-admitted and bypasses the waiting room.
    await TeleconferenceSession.addParticipant(session.id, req.user.id, 'host', 'admitted');

    // Invited participants start as 'invited' (Not in the Meeting). They are
    // NOT placed in the waiting room until they actually try to join.
    await TeleconferenceSession.addParticipant(session.id, client_id, 'client', 'invited');

    // Additional staff (up to 3) are also invited (not waiting) until they join.
    for (const staffId of staffList) {
      if (parseInt(staffId, 10) === req.user.id) continue; // creator already added as host
      await TeleconferenceSession.addParticipant(session.id, staffId, 'staff', 'invited');
    }

    // Log session creation
    await TeleconferenceSession.addLog(session.id, 'session_created', req.user.id, `Session "${title}" created (Meeting ID ${session.meeting_code})`);

    // ── Distribute passwords + a single "meeting has started" notification ──
    // Each invited participant (client + additional staff) is notified. Clicking
    // the notification opens a Join Meeting pop-up (showing their password) and
    // takes them straight into THIS specific meeting.
    const joinLink = `meetings.html?join=${session.id}`;
    const invited = [client_id, ...staffList.filter(s => parseInt(s, 10) !== req.user.id)];
    for (const participantId of invited) {
      try {
        await notificationService.notifyUser(
          participantId, 'teleconference',
          'Your scheduled meeting has started',
          'Click to join your scheduled consultation meeting.',
          joinLink
        );
      } catch (err) { console.error('Meeting notification failed:', err.message); }
    }

    // Fetch full session with names
    const fullSession = await TeleconferenceSession.findById(session.id);

    return res.status(201).json({ success: true, data: fullSession });
  } catch (error) { next(error); }
};

/**
 * Build the participant-facing view of a session: the full participant
 * roster (no passwords), plus the requesting user's own password and status.
 */
async function buildSessionView(session, userId, role) {
  const participants = await TeleconferenceSession.getParticipants(session.id);
  const me = participants.find(p => p.user_id === userId) || null;

  const safeParticipants = participants.map(p => ({
    user_id: p.user_id,
    full_name: p.full_name,
    email: p.email,
    participant_role: p.participant_role,
    admit_status: p.admit_status,
    joined_at: p.joined_at,
  }));

  const amIHost = session.psychologist_id === userId;

  return {
    ...session,
    participants: safeParticipants,
    waiting_count: safeParticipants.filter(p => p.admit_status === 'waiting').length,
    my_admit_status: me ? me.admit_status : (amIHost ? 'admitted' : null),
    am_i_host: amIHost,
  };
}

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

// ── GET /api/teleconference — sessions the user is invited to ──
const getAllSessions = async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    // Only invited participants (host, client, or added staff) can see a meeting.
    // Non-invited users — including other staff — see nothing.
    const sessions = await TeleconferenceSession.findByParticipant(req.user.id, {
      status, limit: parseInt(limit), offset: parseInt(offset),
    });
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

    // Access check: psychologist (host), client, staff, or any listed participant
    const myParticipant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (session.psychologist_id !== req.user.id &&
        session.client_id !== req.user.id &&
        !myParticipant) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const view = await buildSessionView(session, req.user.id, req.user.role);
    return res.json({ success: true, data: view });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/:id/poll — lightweight state for clients/participants ──
const pollSession = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    const myParticipant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (session.psychologist_id !== req.user.id &&
        session.client_id !== req.user.id &&
        !myParticipant) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const view = await buildSessionView(session, req.user.id, req.user.role);
    return res.json({
      success: true,
      data: {
        id: view.id,
        session_status: view.session_status,
        recording_enabled: view.recording_enabled,
        recording_consent_given: view.recording_consent_given,
        recording_response: view.recording_response,
        my_admit_status: view.my_admit_status,
        am_i_host: view.am_i_host,
        waiting_count: view.waiting_count,
        participants: view.participants,
      },
    });
  } catch (error) { next(error); }
};

// ── POST /api/teleconference/:id/join — join session & get Twilio token ──
const joinSession = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Must be a provisioned participant of this session
    const participant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (!participant) {
      return res.status(403).json({ success: false, message: 'You are not a participant of this session.' });
    }

    if (session.session_status === 'ended' || session.session_status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'This session has already ended.' });
    }

    const isHost = session.psychologist_id === req.user.id || participant.participant_role === 'host';

    // ── Waiting room gating (host bypasses) ──
    if (!isHost) {
      if (participant.admit_status === 'denied') {
        return res.status(403).json({ success: false, message: 'The host has not admitted you to this session.' });
      }
      if (participant.admit_status !== 'admitted') {
        if (participant.admit_status !== 'waiting') {
          await TeleconferenceSession.setAdmitStatus(session.id, req.user.id, 'waiting');
        }
        await TeleconferenceSession.addLog(session.id, 'participant_waiting', req.user.id, 'Entered the waiting room.');
        return res.json({ success: true, waiting: true, message: 'Please wait for the host to admit you.' });
      }
    }

    // Admitted (or host): activate session if needed and issue a Twilio token
    if (session.session_status === 'scheduled') {
      await TeleconferenceSession.updateStatus(session.id, 'active');
    }

    await TeleconferenceSession.markJoined(session.id, req.user.id);

    const user = await User.findById(req.user.id);
    const identity = user ? user.full_name : `User-${req.user.id}`;

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_SECRET,
      { identity, ttl: 14400 } // 4 hours
    );

    const videoGrant = new VideoGrant({ room: session.twilio_room_name });
    token.addGrant(videoGrant);

    await TeleconferenceSession.addLog(
      session.id, 'participant_joined', req.user.id,
      `${identity} (${req.user.role}) joined the session`
    );

    return res.json({
      success: true,
      waiting: false,
      data: {
        token: token.toJwt(),
        roomName: session.twilio_room_name,
        identity,
        session,
      },
    });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/admit — host admits or denies a waiting participant ──
const admitParticipant = async (req, res, next) => {
  try {
    const { user_id, admit } = req.body || {};
    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required.' });
    }

    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Only the host may admit/deny
    if (session.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the host can manage the waiting room.' });
    }

    const status = admit ? 'admitted' : 'denied';
    const updated = await TeleconferenceSession.setAdmitStatus(session.id, parseInt(user_id, 10), status);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Participant not found in this session.' });
    }

    await TeleconferenceSession.addLog(
      session.id, admit ? 'participant_admitted' : 'participant_denied', req.user.id,
      `Host ${admit ? 'admitted' : 'denied'} participant (user ${user_id}).`
    );

    return res.json({ success: true, data: updated });
  } catch (error) { next(error); }
};

// ── POST /api/teleconference/:id/leave — participant leaves the call (can rejoin) ──
const leaveSession = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }
    const participant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (!participant) {
      return res.json({ success: true }); // not a participant — nothing to do
    }
    // Clear joined_at so they drop out of the "In this meeting" roster. Keep
    // admit_status (admitted) so they can rejoin without host re-approval.
    await TeleconferenceSession.markLeft(session.id, req.user.id);
    await TeleconferenceSession.addLog(
      session.id, 'participant_left', req.user.id, 'Left the meeting.'
    );
    return res.json({ success: true });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/remove — host removes a participant from the meeting ──
const removeParticipant = async (req, res, next) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required.' });
    }

    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    // Only the host may remove participants
    if (session.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the host can remove participants.' });
    }

    // The host cannot remove themselves
    if (parseInt(user_id, 10) === req.user.id) {
      return res.status(400).json({ success: false, message: 'The host cannot remove themselves.' });
    }

    const updated = await TeleconferenceSession.removeParticipant(session.id, parseInt(user_id, 10));
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Participant not found in this session.' });
    }

    await TeleconferenceSession.addLog(
      session.id, 'participant_removed', req.user.id,
      `Host removed participant (user ${user_id}) from the meeting.`
    );

    return res.json({ success: true, data: updated });
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
    // Reset any prior decision so the client is asked fresh
    await db.query(
      `UPDATE teleconference_sessions SET recording_response = NULL, recording_consent_given = FALSE WHERE id = $1`,
      [session.id]
    );

    await TeleconferenceSession.addLog(
      session.id, 'recording_requested', req.user.id,
      'Psychologist requested recording. Waiting for client consent.'
    );

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

    const approved = consent === true || consent === 'true' || consent === 1 || consent === '1';
    const updated = await TeleconferenceSession.setRecordingResponse(session.id, approved);

    await TeleconferenceSession.addLog(
      session.id, approved ? 'recording_consented' : 'recording_denied', req.user.id,
      approved ? 'Client approved recording (stored as 1).' : 'Client rejected recording (stored as 0).'
    );

    return res.json({
      success: true,
      message: approved ? 'Recording consent granted.' : 'Recording consent denied.',
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

    // Only the host (the psychologist who created the session) can end it
    if (session.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the host can end the session.' });
    }

    const updated = await TeleconferenceSession.updateStatus(session.id, 'ended');

    // Also end the linked meeting if active
    if (session.meeting_id) {
      try { await Meeting.endMeeting(session.meeting_id); } catch (e) {}
    }

    await TeleconferenceSession.addLog(
      session.id, 'session_ended', req.user.id,
      'Session ended by host.'
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

    // Only the host can view the session logs
    if (session.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the host can view the session logs.' });
    }

    const logs = await TeleconferenceSession.getLogs(session.id);
    return res.json({ success: true, data: logs });
  } catch (error) { next(error); }
};

// ── GET /api/teleconference/:id/messages — chat history ──
const getMessages = async (req, res, next) => {
  try {
    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    const myParticipant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (session.psychologist_id !== req.user.id &&
        session.client_id !== req.user.id &&
        !myParticipant) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const sinceId = parseInt(req.query.since, 10) || 0;
    const messages = await TeleconferenceSession.getMessages(session.id, sinceId);
    return res.json({ success: true, data: messages });
  } catch (error) { next(error); }
};

// ── POST /api/teleconference/:id/messages — send a chat message ──
const postMessage = async (req, res, next) => {
  try {
    const { message } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
    }

    const session = await TeleconferenceSession.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    const myParticipant = await TeleconferenceSession.getParticipant(session.id, req.user.id);
    if (session.psychologist_id !== req.user.id &&
        session.client_id !== req.user.id &&
        !myParticipant) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const saved = await TeleconferenceSession.addMessage(session.id, req.user.id, String(message).trim().slice(0, 2000));
    return res.status(201).json({ success: true, data: saved });
  } catch (error) { next(error); }
};

// ── PUT /api/teleconference/:id/assign-client — assign a client to a session ──
const assignClient = async (req, res, next) => {
  try {
    const { client_id } = req.body;
    if (!client_id) {
      return res.status(400).json({ success: false, message: 'client_id is required.' });
    }

    // Eligibility: the assigned client's account must be verified.
    const eligibility = await getEligibleClientOrError(client_id);
    if (eligibility.error) {
      return res.status(400).json({ success: false, message: eligibility.error });
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
  createSession, getMySessions, getAllSessions, getSession, pollSession,
  joinSession, admitParticipant, removeParticipant, leaveSession, startRecording, consentRecording, endSession,
  getSessionLogs, getMessages, postMessage, assignClient, getClients, getStaffList, stopRecording,
};
