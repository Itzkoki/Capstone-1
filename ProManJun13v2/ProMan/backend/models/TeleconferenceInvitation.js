const crypto = require('crypto');
const db = require('../config/db');

// Only the SHA-256 hash of a token is ever stored. The raw token exists solely
// in the emailed link and in transit — so a database leak yields no usable
// tokens (same principle as password hashing).
const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

const TeleconferenceInvitation = {
  hashToken,

  /**
   * Generate a cryptographically secure, single-use invitation. Returns the RAW
   * token (to embed in the emailed link) plus the persisted row. The raw token
   * is NEVER stored — only its hash.
   */
  async create({ sessionId, meetingId, clientId, expiresAt, createdBy }) {
    const raw = crypto.randomBytes(32).toString('base64url'); // 256-bit, URL-safe
    const tokenHash = hashToken(raw);
    const result = await db.query(
      `INSERT INTO teleconference_invitations
         (session_id, meeting_id, client_id, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, session_id, meeting_id, client_id, status, expires_at, created_at`,
      [sessionId, meetingId || null, clientId, tokenHash, expiresAt, createdBy || null]
    );
    return { raw, invitation: result.rows[0] };
  },

  async findByRawToken(raw) {
    const result = await db.query(
      `SELECT * FROM teleconference_invitations WHERE token_hash = $1`,
      [hashToken(raw)]
    );
    return result.rows[0] || null;
  },

  /**
   * Atomically consume an ACTIVE invitation. The `WHERE status = 'active'` guard
   * means only ONE concurrent request can win the UPDATE — this is the
   * replay / double-use protection. Returns the row if claimed, or null if it
   * was already used/expired/revoked (or lost the race).
   */
  async claim(id, { ip, userAgent } = {}) {
    const result = await db.query(
      `UPDATE teleconference_invitations
         SET status = 'used', used_at = NOW(), used_ip = $2, used_user_agent = $3
       WHERE id = $1 AND status = 'active'
       RETURNING *`,
      [id, ip || null, userAgent || null]
    );
    return result.rows[0] || null;
  },

  async markExpired(id) {
    await db.query(
      `UPDATE teleconference_invitations SET status = 'expired'
       WHERE id = $1 AND status = 'active'`,
      [id]
    );
  },

  async revoke(id) {
    const result = await db.query(
      `UPDATE teleconference_invitations SET status = 'revoked'
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [id]
    );
    return result.rows[0] || null;
  },

  // Revoke every still-active invite for a session (e.g. when the session ends
  // or is cancelled) so no outstanding link can ever be redeemed afterward.
  async revokeBySession(sessionId) {
    await db.query(
      `UPDATE teleconference_invitations SET status = 'revoked'
       WHERE session_id = $1 AND status = 'active'`,
      [sessionId]
    );
  },
};

module.exports = TeleconferenceInvitation;
