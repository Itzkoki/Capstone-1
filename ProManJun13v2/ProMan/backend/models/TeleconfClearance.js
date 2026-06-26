const db = require('../config/db');

// Server-side record that a user passed the teleconference OTP. This is what
// turns the OTP from a browser-only gate into a real boundary: the join /
// reconnect endpoints require a FRESH clearance here before issuing a Twilio
// token, so an API-level intruder who skips the UI is denied.
//
// The clearance window is kept in sync with the seat grace window
// (TELECONF_SEAT_GRACE_MS, default 3 min): while a participant is connected,
// the heartbeat slides BOTH forward so neither expires mid-call. Once they
// leave/disconnect, the heartbeats stop and the clearance lapses ~grace later —
// so rejoining AFTER the grace window requires a fresh OTP, exactly like the
// seat binding frees at the same time. Keep this equal to the grace minutes.
const DEFAULT_WINDOW_MIN = parseInt(process.env.TELECONF_OTP_CLEARANCE_MIN || '3', 10); // 3 min

const TeleconfClearance = {
  DEFAULT_WINDOW_MIN,

  // Grant (or refresh) clearance for a participant (user_id + is_staff) IN A
  // SPECIFIC SESSION. The is_staff flag keeps a staff account and a client
  // account distinct even if their ids collide, so their grace never mixes.
  async grant(userId, isStaff, sessionId, windowMin = DEFAULT_WINDOW_MIN) {
    const result = await db.query(
      `INSERT INTO teleconference_otp_clearance (user_id, is_staff, session_id, verified_at, expires_at)
       VALUES ($1, $2, $3, NOW(), NOW() + ($4 * interval '1 minute'))
       ON CONFLICT (user_id, is_staff, session_id) DO UPDATE
         SET verified_at = NOW(),
             expires_at  = NOW() + ($4 * interval '1 minute')
       RETURNING *`,
      [userId, !!isStaff, sessionId, windowMin]
    );
    return result.rows[0];
  },

  // True if this participant holds a non-expired clearance for THIS session.
  async isFresh(userId, isStaff, sessionId) {
    const result = await db.query(
      `SELECT 1 FROM teleconference_otp_clearance
       WHERE user_id = $1 AND is_staff = $2 AND session_id = $3 AND expires_at > NOW()`,
      [userId, !!isStaff, sessionId]
    );
    return result.rowCount === 1;
  },

  // Slide this participant's clearance forward (on heartbeat / leave) so an
  // active call keeps it alive. No-op if there is no live clearance.
  async extend(userId, isStaff, sessionId, windowMin = DEFAULT_WINDOW_MIN) {
    await db.query(
      `UPDATE teleconference_otp_clearance
         SET expires_at = NOW() + ($4 * interval '1 minute')
       WHERE user_id = $1 AND is_staff = $2 AND session_id = $3 AND expires_at > NOW()`,
      [userId, !!isStaff, sessionId, windowMin]
    );
  },

  async revoke(userId, isStaff, sessionId) {
    await db.query(
      `DELETE FROM teleconference_otp_clearance WHERE user_id = $1 AND is_staff = $2 AND session_id = $3`,
      [userId, !!isStaff, sessionId]
    );
  },
};

module.exports = TeleconfClearance;
