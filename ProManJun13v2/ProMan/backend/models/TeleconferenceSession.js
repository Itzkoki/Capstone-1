const crypto = require('crypto');
const db = require('../config/db');

const TeleconferenceSession = {
  /**
   * Generate a secure access token for session participants.
   */
  generateAccessToken() {
    return crypto.randomBytes(32).toString('hex');
  },

  /**
   * Generate a short, human-readable meeting ID/code, e.g. "BPS-7G2KQ9".
   */
  generateMeetingCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length];
    return `BPS-${code}`;
  },

  /**
   * Create a new teleconference session.
   */
  async create({ meetingId, psychologistId, clientId, twilioRoomSid, twilioRoomName }) {
    const accessToken = this.generateAccessToken();
    const meetingCode = this.generateMeetingCode();
    const result = await db.query(
      `INSERT INTO teleconference_sessions
         (meeting_id, psychologist_id, client_id, access_token, meeting_code, twilio_room_sid, twilio_room_name, session_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')
       RETURNING *`,
      [meetingId, psychologistId, clientId || null, accessToken, meetingCode, twilioRoomSid || null, twilioRoomName || null]
    );
    return result.rows[0];
  },

  async findById(id) {
    const result = await db.query(
      `SELECT ts.*,
              p.full_name AS psychologist_name,
              p.email     AS psychologist_email,
              c.full_name AS client_name,
              c.email     AS client_email,
              m.title     AS meeting_title
       FROM teleconference_sessions ts
       LEFT JOIN users u ON FALSE
       LEFT JOIN users p ON p.id = ts.psychologist_id
       LEFT JOIN users c ON c.id = ts.client_id
       LEFT JOIN meetings m ON m.id = ts.meeting_id
       WHERE ts.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async findByMeetingId(meetingId) {
    const result = await db.query(
      `SELECT ts.*,
              p.full_name AS psychologist_name,
              c.full_name AS client_name
       FROM teleconference_sessions ts
       LEFT JOIN users p ON p.id = ts.psychologist_id
       LEFT JOIN users c ON c.id = ts.client_id
       WHERE ts.meeting_id = $1`,
      [meetingId]
    );
    return result.rows[0] || null;
  },

  /**
   * Find sessions for a specific user (as psychologist or client).
   */
  async findByParticipant(userId, { status, limit = 20, offset = 0 } = {}) {
    let query = `
      SELECT ts.*,
             p.full_name AS psychologist_name,
             c.full_name AS client_name,
             m.title     AS meeting_title
      FROM teleconference_sessions ts
      LEFT JOIN users p ON p.id = ts.psychologist_id
      LEFT JOIN users c ON c.id = ts.client_id
      LEFT JOIN meetings m ON m.id = ts.meeting_id
      WHERE (ts.psychologist_id = $1
             OR ts.client_id = $1
             OR EXISTS (SELECT 1 FROM session_participants sp
                        WHERE sp.session_id = ts.id AND sp.user_id = $1))`;
    const params = [userId];
    let idx = 2;

    if (status) {
      query += ` AND ts.session_status = $${idx++}`;
      params.push(status);
    }

    query += ` ORDER BY ts.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  /**
   * Find all sessions (staff view).
   */
  async findAll({ status, limit = 50, offset = 0 } = {}) {
    let query = `
      SELECT ts.*,
             p.full_name AS psychologist_name,
             c.full_name AS client_name,
             m.title     AS meeting_title
      FROM teleconference_sessions ts
      LEFT JOIN users p ON p.id = ts.psychologist_id
      LEFT JOIN users c ON c.id = ts.client_id
      LEFT JOIN meetings m ON m.id = ts.meeting_id
      WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (status) {
      query += ` AND ts.session_status = $${idx++}`;
      params.push(status);
    }

    query += ` ORDER BY ts.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  async updateStatus(id, status) {
    const extras = {};
    if (status === 'active') extras.started_at = 'NOW()';
    if (status === 'ended') extras.ended_at = 'NOW()';

    let setClause = `session_status = $1`;
    const params = [status];
    let idx = 2;

    if (status === 'active') {
      setClause += `, started_at = NOW()`;
    }
    if (status === 'ended') {
      setClause += `, ended_at = NOW()`;
    }

    const result = await db.query(
      `UPDATE teleconference_sessions SET ${setClause} WHERE id = $${idx} RETURNING *`,
      [...params, id]
    );
    return result.rows[0] || null;
  },

  async updateTwilioRoom(id, roomSid, roomName) {
    const result = await db.query(
      `UPDATE teleconference_sessions SET twilio_room_sid = $1, twilio_room_name = $2 WHERE id = $3 RETURNING *`,
      [roomSid, roomName, id]
    );
    return result.rows[0] || null;
  },

  async startRecording(id) {
    const result = await db.query(
      `UPDATE teleconference_sessions SET recording_enabled = TRUE WHERE id = $1 RETURNING *`,
      [id]
    );
    return result.rows[0] || null;
  },

  async setRecordingConsent(id, consent) {
    const result = await db.query(
      `UPDATE teleconference_sessions SET recording_consent_given = $1 WHERE id = $2 RETURNING *`,
      [consent, id]
    );
    return result.rows[0] || null;
  },

  /**
   * Store the client's recording decision as 1 (approved) or 0 (rejected),
   * and keep the boolean consent flag in sync.
   */
  async setRecordingResponse(id, response) {
    const val = response ? 1 : 0;
    const result = await db.query(
      `UPDATE teleconference_sessions
         SET recording_response = $1,
             recording_consent_given = $2
       WHERE id = $3
       RETURNING *`,
      [val, val === 1, id]
    );
    return result.rows[0] || null;
  },

  // ── Session Participants (host + client + up to 3 staff) ──

  async addParticipant(sessionId, userId, participantRole, admitStatus = 'waiting') {
    const result = await db.query(
      `INSERT INTO session_participants (session_id, user_id, participant_role, admit_status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, user_id) DO UPDATE
         SET participant_role = EXCLUDED.participant_role,
             admit_status     = EXCLUDED.admit_status
       RETURNING *`,
      [sessionId, userId, participantRole, admitStatus]
    );
    return result.rows[0];
  },

  async getParticipants(sessionId) {
    const result = await db.query(
      `SELECT sp.*, u.full_name, u.email, u.role AS user_role
       FROM session_participants sp
       JOIN users u ON u.id = sp.user_id
       WHERE sp.session_id = $1
       ORDER BY
         CASE sp.participant_role WHEN 'host' THEN 0 WHEN 'client' THEN 1 ELSE 2 END,
         u.full_name`,
      [sessionId]
    );
    return result.rows;
  },

  async getParticipant(sessionId, userId) {
    const result = await db.query(
      `SELECT * FROM session_participants WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId]
    );
    return result.rows[0] || null;
  },

  async setAdmitStatus(sessionId, userId, status) {
    const result = await db.query(
      `UPDATE session_participants SET admit_status = $1 WHERE session_id = $2 AND user_id = $3 RETURNING *`,
      [status, sessionId, userId]
    );
    return result.rows[0] || null;
  },

  async markJoined(sessionId, userId) {
    const result = await db.query(
      `UPDATE session_participants SET joined_at = NOW() WHERE session_id = $1 AND user_id = $2 RETURNING *`,
      [sessionId, userId]
    );
    return result.rows[0] || null;
  },

  // Participant leaves the call voluntarily: clear joined_at so they drop out of
  // the "In this meeting" roster, but keep their admit_status (admitted) so they
  // can rejoin without waiting for the host again.
  async markLeft(sessionId, userId) {
    const result = await db.query(
      `UPDATE session_participants SET joined_at = NULL WHERE session_id = $1 AND user_id = $2 RETURNING *`,
      [sessionId, userId]
    );
    return result.rows[0] || null;
  },

  // Host removes a participant from the meeting: block re-entry (denied) and
  // clear their joined_at so they drop out of the "In this meeting" roster.
  async removeParticipant(sessionId, userId) {
    const result = await db.query(
      `UPDATE session_participants
         SET admit_status = 'denied', joined_at = NULL
       WHERE session_id = $1 AND user_id = $2
       RETURNING *`,
      [sessionId, userId]
    );
    return result.rows[0] || null;
  },

  async countParticipants(sessionId) {
    const result = await db.query(
      `SELECT COUNT(*) AS count FROM session_participants WHERE session_id = $1`,
      [sessionId]
    );
    return parseInt(result.rows[0].count, 10);
  },

  // ── In-meeting chat ──

  async addMessage(sessionId, userId, message) {
    const result = await db.query(
      `INSERT INTO session_messages (session_id, user_id, message)
       VALUES ($1, $2, $3) RETURNING *`,
      [sessionId, userId, message]
    );
    return result.rows[0];
  },

  async getMessages(sessionId, sinceId = 0) {
    const result = await db.query(
      `SELECT sm.id, sm.session_id, sm.user_id, sm.message, sm.created_at,
              u.full_name, u.role AS user_role
       FROM session_messages sm
       LEFT JOIN users u ON u.id = sm.user_id
       WHERE sm.session_id = $1 AND sm.id > $2
       ORDER BY sm.id ASC`,
      [sessionId, sinceId]
    );
    return result.rows;
  },

  async setRecordingUrl(id, url) {
    const result = await db.query(
      `UPDATE teleconference_sessions SET recording_url = $1 WHERE id = $2 RETURNING *`,
      [url, id]
    );
    return result.rows[0] || null;
  },

  /**
   * Verify a user has access to a session.
   */
  async verifyAccess(sessionId, userId, accessToken) {
    const result = await db.query(
      `SELECT * FROM teleconference_sessions
       WHERE id = $1 AND access_token = $2
         AND (psychologist_id = $3 OR client_id = $3)`,
      [sessionId, accessToken, userId]
    );
    return result.rows[0] || null;
  },

  // ── Session Logs ──

  async addLog(sessionId, eventType, participantId, details = null) {
    const result = await db.query(
      `INSERT INTO session_logs (session_id, event_type, participant_id, details)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [sessionId, eventType, participantId || null, details]
    );
    return result.rows[0];
  },

  async getLogs(sessionId) {
    const result = await db.query(
      `SELECT sl.*, u.full_name AS participant_name
       FROM session_logs sl
       LEFT JOIN users u ON u.id = sl.participant_id
       WHERE sl.session_id = $1
       ORDER BY sl.created_at ASC`,
      [sessionId]
    );
    return result.rows;
  },

  async getActiveCount() {
    const result = await db.query(
      `SELECT COUNT(*) AS count FROM teleconference_sessions WHERE session_status = 'active'`
    );
    return parseInt(result.rows[0].count, 10);
  },
};

module.exports = TeleconferenceSession;
