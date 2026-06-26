const crypto = require('crypto');
const db = require('../config/db');

// ── Identity resolution across the two account tables ────────────────────────
// Staff now live in the dedicated `staff` table (staff_id) while clients remain
// in `users` (id). Teleconference rows store a bare numeric id in
// psychologist_id / client_id / session_participants.user_id, so a name must be
// resolved against the correct table. We disambiguate using the row's KNOWN role:
//   • host/staff  → prefer the `staff` table, fall back to `users` (legacy staff)
//   • client      → prefer `users`
// These SQL fragments are reused by the queries below. `st`/`stp` = staff alias,
// `u`/`up` = users alias.
const STAFF_NAME = (st) => `NULLIF(TRIM(CONCAT_WS(' ', ${st}.first_name, ${st}.last_name)), '')`;

// Fixed, ordered emoji alphabet (64 entries) used to render a session's
// cryptographic fingerprint. The index math below maps each fingerprint byte to
// one of these, so the mapping is deterministic and identical for everyone.
const SECURITY_EMOJI_SET = [
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔',
  '🦄','🐝','🦋','🐢','🐙','🐬','🐳','🦀','🌵','🌲','🍀','🌻','🌹','🍁','🍄','🌍',
  '🍎','🍊','🍋','🍉','🍓','🍒','🍑','🥝','🌽','🥕','🍔','🍕','🌮','🍿','🍩','🍪',
  '⚽','🏀','🎾','🏆','🎸','🎹','🎺','🎲','🚗','✈️','🚀','⛵','🏰','🗼','💎','🔔',
];

const TeleconferenceSession = {
  /**
   * Generate a secure access token for session participants.
   */
  generateAccessToken() {
    return crypto.randomBytes(32).toString('hex');
  },

  /**
   * Derive a deterministic 4-emoji security fingerprint from a session's secret
   * key (its access token). Uses SHA-256, then maps the first four bytes onto a
   * fixed emoji alphabet. The same session key always yields the same emojis for
   * every participant; a new session (new key) yields a different sequence.
   *
   * SECURITY: the raw key is NEVER returned or stored — only the derived emojis.
   * @param {string} sessionKey
   * @returns {string[]} four emoji strings (empty array if no key)
   */
  securityEmojis(sessionKey) {
    if (!sessionKey) return [];
    const digest = crypto.createHash('sha256').update(String(sessionKey)).digest();
    const out = [];
    for (let i = 0; i < 4; i++) {
      out.push(SECURITY_EMOJI_SET[digest[i] % SECURITY_EMOJI_SET.length]);
    }
    return out;
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
  async create({ meetingId, psychologistId, clientId, twilioRoomSid, twilioRoomName, appointmentId }) {
    const accessToken = this.generateAccessToken();
    const meetingCode = this.generateMeetingCode();
    const result = await db.query(
      `INSERT INTO teleconference_sessions
         (meeting_id, psychologist_id, client_id, access_token, meeting_code, twilio_room_sid, twilio_room_name, session_status, appointment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', $8)
       RETURNING *`,
      [meetingId, psychologistId, clientId || null, accessToken, meetingCode, twilioRoomSid || null, twilioRoomName || null, appointmentId || null]
    );
    return result.rows[0];
  },

  async findById(id) {
    const result = await db.query(
      `SELECT ts.*,
              COALESCE(${STAFF_NAME('stp')}, up.full_name) AS psychologist_name,
              COALESCE(stp.email, up.email)                AS psychologist_email,
              c.full_name AS client_name,
              c.email     AS client_email,
              m.title     AS meeting_title
       FROM teleconference_sessions ts
       LEFT JOIN staff stp ON stp.staff_id = ts.psychologist_id
       LEFT JOIN users up   ON up.id       = ts.psychologist_id
       LEFT JOIN users c    ON c.id        = ts.client_id
       LEFT JOIN meetings m ON m.id        = ts.meeting_id
       WHERE ts.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async findByMeetingId(meetingId) {
    const result = await db.query(
      `SELECT ts.*,
              COALESCE(${STAFF_NAME('stp')}, up.full_name) AS psychologist_name,
              c.full_name AS client_name
       FROM teleconference_sessions ts
       LEFT JOIN staff stp ON stp.staff_id = ts.psychologist_id
       LEFT JOIN users up   ON up.id       = ts.psychologist_id
       LEFT JOIN users c    ON c.id        = ts.client_id
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
             COALESCE(${STAFF_NAME('stp')}, up.full_name) AS psychologist_name,
             c.full_name AS client_name,
             m.title     AS meeting_title
      FROM teleconference_sessions ts
      LEFT JOIN staff stp ON stp.staff_id = ts.psychologist_id
      LEFT JOIN users up   ON up.id       = ts.psychologist_id
      LEFT JOIN users c    ON c.id        = ts.client_id
      LEFT JOIN meetings m ON m.id        = ts.meeting_id
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
             COALESCE(${STAFF_NAME('stp')}, up.full_name) AS psychologist_name,
             c.full_name AS client_name,
             m.title     AS meeting_title
      FROM teleconference_sessions ts
      LEFT JOIN staff stp ON stp.staff_id = ts.psychologist_id
      LEFT JOIN users up   ON up.id       = ts.psychologist_id
      LEFT JOIN users c    ON c.id        = ts.client_id
      LEFT JOIN meetings m ON m.id        = ts.meeting_id
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

  /**
   * Host requests recording: marks the request pending WITHOUT starting it.
   * Recording only actually starts once the client approves (see
   * setRecordingResponse). Clears any prior decision so the client is asked fresh.
   */
  async requestRecording(id) {
    const result = await db.query(
      `UPDATE teleconference_sessions
         SET recording_requested = TRUE,
             recording_enabled = FALSE,
             recording_response = NULL,
             recording_consent_given = FALSE
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return result.rows[0] || null;
  },

  /**
   * Fully reset/stop recording: not recording, no pending request, no decision.
   */
  async resetRecording(id) {
    const result = await db.query(
      `UPDATE teleconference_sessions
         SET recording_enabled = FALSE,
             recording_requested = FALSE,
             recording_response = NULL,
             recording_consent_given = FALSE
       WHERE id = $1
       RETURNING *`,
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
   * Apply the client's recording decision. ON APPROVAL recording actually starts
   * (recording_enabled = TRUE); on rejection it stays off. Either way the pending
   * request is cleared.
   */
  async setRecordingResponse(id, response) {
    const approved = !!response;
    const result = await db.query(
      `UPDATE teleconference_sessions
         SET recording_response = $1,
             recording_consent_given = $2,
             recording_enabled = $2,
             recording_requested = FALSE
       WHERE id = $3
       RETURNING *`,
      [approved ? 1 : 0, approved, id]
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
    // Resolve each participant against the correct account table using the row's
    // known role: clients live in `users`, host/staff in `staff` (with a
    // `users` fallback for legacy staff accounts).
    const result = await db.query(
      `SELECT sp.*,
              CASE WHEN sp.participant_role = 'client'
                   THEN COALESCE(u.full_name, ${STAFF_NAME('st')})
                   ELSE COALESCE(${STAFF_NAME('st')}, u.full_name)
              END AS full_name,
              -- Canonical display label used by the roster AND the video tile, so
              -- camera/mic state (keyed by this value) lines up. Clients show
              -- their full name; staff show "FirstName (Role)" — never staff_id.
              CASE
                WHEN sp.participant_role = 'client'
                  THEN COALESCE(u.full_name, ${STAFF_NAME('st')}, 'Participant')
                WHEN st.staff_id IS NOT NULL
                  THEN COALESCE(st.first_name, ${STAFF_NAME('st')}, 'Staff')
                       || COALESCE(' (' || INITCAP(REPLACE(st.role, '_', ' ')) || ')', '')
                ELSE COALESCE(${STAFF_NAME('st')}, u.full_name, 'Participant')
              END AS display_name,
              CASE WHEN sp.participant_role = 'client'
                   THEN COALESCE(u.email, st.email)
                   ELSE COALESCE(st.email, u.email)
              END AS email,
              CASE WHEN sp.participant_role = 'client'
                   THEN COALESCE(u.role, st.role)
                   ELSE COALESCE(st.role, u.role)
              END AS user_role
       FROM session_participants sp
       LEFT JOIN users u ON u.id       = sp.user_id
       LEFT JOIN staff st ON st.staff_id = sp.user_id
       WHERE sp.session_id = $1
       ORDER BY
         CASE sp.participant_role WHEN 'host' THEN 0 WHEN 'client' THEN 1 ELSE 2 END,
         full_name`,
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
  // Participant leaves voluntarily: drop them from the live roster (clear
  // joined_at + connection_token) but KEEP reconnect_token_hash and stamp
  // last_heartbeat = NOW() to START THE GRACE CLOCK. The seat stays bound to
  // this device for SEAT_GRACE_MS after leaving; only the matching token may
  // rejoin during that window. Once the grace window passes (no fresh
  // heartbeat), the binding is considered expired and another device may claim
  // the seat. The binding is also cleared immediately by a host remove /
  // session end (see releaseSeat).
  async markLeft(sessionId, userId) {
    const result = await db.query(
      `UPDATE session_participants
         SET joined_at = NULL, connection_token = NULL, last_heartbeat = NOW()
       WHERE session_id = $1 AND user_id = $2 RETURNING *`,
      [sessionId, userId]
    );
    return result.rows[0] || null;
  },

  // ── Live-call seat lock (duplicate-entry prevention) ──

  // True if this participant currently holds an ACTIVE seat: joined AND
  // heartbeating within the freshness window. A stale heartbeat means the
  // previous connection dropped, so the seat is considered free.
  async isSeatActive(sessionId, userId, freshnessMs = 30000) {
    const p = await this.getParticipant(sessionId, userId);
    if (!p || !p.joined_at || !p.last_heartbeat) return false;
    return (Date.now() - new Date(p.last_heartbeat).getTime()) < freshnessMs;
  },

  // Claim the seat for this join: store the per-connection token, the durable
  // reconnect-token HASH, and mark the participant joined + freshly heartbeating.
  async claimSeat(sessionId, userId, connectionToken, reconnectTokenHash = null) {
    const result = await db.query(
      `UPDATE session_participants
         SET connection_token = $3, reconnect_token_hash = $4,
             joined_at = NOW(), last_heartbeat = NOW()
       WHERE session_id = $1 AND user_id = $2
       RETURNING *`,
      [sessionId, userId, connectionToken, reconnectTokenHash]
    );
    return result.rows[0] || null;
  },

  // Refresh last_heartbeat ONLY if the presented connection token matches the
  // seat holder. A device without the token cannot keep the seat alive.
  // Returns true if the heartbeat was accepted.
  async touchHeartbeat(sessionId, userId, connectionToken) {
    const result = await db.query(
      `UPDATE session_participants
         SET last_heartbeat = NOW()
       WHERE session_id = $1 AND user_id = $2 AND connection_token = $3
       RETURNING id`,
      [sessionId, userId, connectionToken]
    );
    return result.rowCount === 1;
  },

  // Free the seat (on leave / removal / session end).
  async releaseSeat(sessionId, userId) {
    await db.query(
      `UPDATE session_participants
         SET connection_token = NULL, reconnect_token_hash = NULL, last_heartbeat = NULL
       WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId]
    );
  },

  // Free EVERY participant's seat + device binding for a session (used when the
  // host ends the call for all — no token can reconnect afterward).
  async releaseAllSeats(sessionId) {
    await db.query(
      `UPDATE session_participants
         SET joined_at = NULL, connection_token = NULL,
             reconnect_token_hash = NULL, last_heartbeat = NULL
       WHERE session_id = $1`,
      [sessionId]
    );
  },

  // Host removes a participant from the meeting: block re-entry (denied) and
  // clear their joined_at so they drop out of the "In this meeting" roster.
  async removeParticipant(sessionId, userId) {
    const result = await db.query(
      `UPDATE session_participants
         SET admit_status = 'denied', joined_at = NULL,
             connection_token = NULL, reconnect_token_hash = NULL, last_heartbeat = NULL
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
              COALESCE(u.full_name, ${STAFF_NAME('st')}) AS full_name,
              COALESCE(u.role, st.role)                  AS user_role
       FROM session_messages sm
       LEFT JOIN users u  ON u.id       = sm.user_id
       LEFT JOIN staff st ON st.staff_id = sm.user_id
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
      `SELECT sl.*,
              COALESCE(${STAFF_NAME('st')}, u.full_name) AS participant_name
       FROM session_logs sl
       LEFT JOIN users u  ON u.id       = sl.participant_id
       LEFT JOIN staff st ON st.staff_id = sl.participant_id
       WHERE sl.session_id = $1
       ORDER BY sl.created_at DESC, sl.id DESC`,
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
