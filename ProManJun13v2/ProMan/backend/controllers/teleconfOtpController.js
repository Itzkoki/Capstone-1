const TeleconfOtp       = require('../models/TeleconfOtp');
const TeleconfClearance = require('../models/TeleconfClearance');
const User        = require('../models/User');
const Staff       = require('../models/Staff');
const db          = require('../config/db');
const { sendTeleconfOtpEmail } = require('../services/emailService');
const securityEvents = require('../services/securityEvents');

// Teleconference is used by BOTH clients (users.id) and staff (staff.staff_id),
// so resolve the recipient's email/name from whichever table the id belongs to.
async function resolveRecipient(id) {
  const user = await User.findById(id);
  if (user) return { email: user.email, name: user.full_name };
  const staff = await Staff.findById(id);
  if (staff) return { email: staff.email, name: [staff.first_name, staff.last_name].filter(Boolean).join(' ').trim() || 'there' };
  return null;
}

// ── POST /api/teleconference/otp/send ────────────────────────────────
// Requires auth. Generates a fresh OTP and emails it to the user.
const sendOtp = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const recipient = await resolveRecipient(userId);

    if (!recipient || !recipient.email) {
      return res.status(404).json({ success: false, message: 'Account email not found.' });
    }

    // Rate limit: the initial code + one resend are allowed immediately; after
    // that a 2-minute cooldown applies before another code can be sent.
    const rs = await TeleconfOtp.resendStatus(userId);
    if (!rs.allowed) {
      return res.status(429).json({
        success: false,
        message: `Please wait ${rs.retryAfter} second${rs.retryAfter === 1 ? '' : 's'} before requesting another code.`,
        retryAfter: rs.retryAfter,
      });
    }

    const otp = await TeleconfOtp.create(userId);

    try {
      await sendTeleconfOtpEmail(recipient.email, otp, recipient.name);
    } catch (emailErr) {
      console.error('⚠️  Failed to send teleconf OTP email:', emailErr.message);
    }

    await _auditLog(userId, 'otp_generated', 'teleconference', req.ip);

    return res.status(200).json({
      success: true,
      message: `A verification code has been sent to your registered email. It expires in ${TeleconfOtp.OTP_EXPIRY_MINUTES} minutes.`,
      expires_in_minutes: TeleconfOtp.OTP_EXPIRY_MINUTES,
      resend_cooldown_seconds: TeleconfOtp.RESEND_COOLDOWN_SECONDS,
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/teleconference/otp/verify ──────────────────────────────
// Requires auth. Verifies the OTP the user submitted.
const verifyOtp = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { otp, session_id } = req.body;

    if (!otp || otp.length !== 6 || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid 6-digit code.' });
    }

    // OTP is now PER-SESSION: a session must be supplied so the clearance is
    // scoped to that conference (each conference requires its own OTP).
    const sessionId = parseInt(session_id, 10);
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'A teleconference session is required for verification.' });
    }

    const result = await TeleconfOtp.verify(userId, otp);

    if (!result.valid) {
      // Route through the security pipeline: a single failure is LOW (logged
      // only); repeated failures auto-escalate to a tracked MEDIUM incident and
      // notify the Clinical Director.
      await securityEvents.record({
        module: 'teleconference', eventType: 'otp_failure',
        userId, ip: req.ip, subjectKind: req.user.type === 'staff' ? 'staff' : 'user',
        targetType: 'session', targetId: sessionId,
        details: `OTP verification failed for session ${sessionId}.`,
      });
      return res.status(400).json({ success: false, message: result.reason });
    }

    // Record a SERVER-SIDE clearance for THIS session so the join/reconnect
    // endpoints can require proof of OTP before issuing a Twilio token (the
    // frontend flag is not a boundary on its own). Per-session + slides on
    // heartbeat. Guard the FK in case the session id is invalid.
    try {
      await TeleconfClearance.grant(userId, req.user.type === 'staff', sessionId);
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Could not verify for this session. Please reopen the meeting and try again.' });
    }

    await _auditLog(userId, 'otp_verification_success', 'teleconference', req.ip);
    await _auditLog(userId, 'teleconference_access_granted', 'teleconference', req.ip);

    return res.status(200).json({ success: true, message: 'Verified. You may now join the teleconference.' });
  } catch (err) {
    next(err);
  }
};

async function _auditLog(userId, eventType, context, ip) {
  try {
    await db.query(
      `INSERT INTO security_audit_log (user_id, event_type, context, ip_address, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [userId, eventType, context, ip || null]
    );
  } catch (_) {} // non-fatal
}

module.exports = { sendOtp, verifyOtp };
