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
   * Create a new teleconference session.
   */
  async create({ meetingId, psychologistId, clientId, twilioRoomSid, twilioRoomName }) {
    const accessToken = this.generateAccessToken();
    const result = await db.query(
      `INSERT INTO teleconference_sessions
         (meeting_id, psychologist_id, client_id, access_token, twilio_room_sid, twilio_room_name, session_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
       RETURNING *`,
      [meetingId, psychologistId, clientId || null, accessToken, twilioRoomSid || null, twilioRoomName || null]
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
      WHERE (ts.psychologist_id = $1 OR ts.client_id = $1)`;
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
