const ModuleOtp = require('../models/ModuleOtp');
const User      = require('../models/User');
const Staff     = require('../models/Staff');
const db        = require('../config/db');
const { sendModuleAccessOtpEmail } = require('../services/emailService');
const securityEvents = require('../services/securityEvents');

// Email-OTP gate for sensitive STAFF-only modules. The client sends a `module`
// key from this allowlist; the value is the human-readable label used in the
// email + audit trail.
const MODULES = {
  case_management:      'Case Management',
  staff_management:     'Staff Management',
  payment_verification: 'Payment Verification',
};

// Per-module role allowlist. The OTP gate is a SECOND factor for module access —
// it must never be reached by a role that isn't authorized for the module in the
// first place. We check this BEFORE sending/verifying any code so an
// unauthorized user gets an immediate 403 instead of an OTP prompt.
// Mirrors the route-level RBAC (case mgmt = any staff; payment verification =
// supervising psychometrician + CD; staff management = CD only).
const MODULE_ROLES = {
  case_management:      ['psychometrician', 'supervising_psychometrician', 'qc_psychometrician', 'psychologist', 'clinical_director'],
  payment_verification: ['supervising_psychometrician', 'clinical_director'],
  staff_management:     ['clinical_director'],
};

// Returns true when `role` may access `module`. Unknown modules → false.
function roleAllowedForModule(role, module) {
  const allowed = MODULE_ROLES[module];
  return Array.isArray(allowed) && allowed.includes(role);
}

// These modules are reached by both legacy users-CDs (users.id) and clinical
// staff (staff.staff_id), so resolve the recipient from whichever table owns id.
async function resolveRecipient(id) {
  const user = await User.findById(id);
  if (user) return { email: user.email, name: user.full_name };
  const staff = await Staff.findById(id);
  if (staff) return { email: staff.email, name: [staff.first_name, staff.last_name].filter(Boolean).join(' ').trim() || 'there' };
  return null;
}

// ── POST /api/module-otp/send ─────────────────────────────────────────
// Requires auth (staff only). Generates a fresh OTP and emails it to the user.
const sendOtp = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const role   = req.user.role || '';
    const module = String(req.body.module || '');

    if (role === 'client') {
      return res.status(403).json({ success: false, message: 'Access denied. Staff only.' });
    }
    if (!MODULES[module]) {
      return res.status(400).json({ success: false, message: 'Unknown module.' });
    }
    // Authorize the role for THIS module before issuing any code (no OTP for
    // users who aren't allowed into the module at all).
    if (!roleAllowedForModule(role, module)) {
      return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions for this module.' });
    }

    const recipient = await resolveRecipient(userId);
    if (!recipient || !recipient.email) {
      return res.status(404).json({ success: false, message: 'Account email not found.' });
    }

    // Rate limit: initial code + one resend free, then a 2-minute cooldown.
    const rs = await ModuleOtp.resendStatus(userId);
    if (!rs.allowed) {
      return res.status(429).json({
        success: false,
        message: `Please wait ${rs.retryAfter} second${rs.retryAfter === 1 ? '' : 's'} before requesting another code.`,
        retryAfter: rs.retryAfter,
      });
    }

    const otp = await ModuleOtp.create(userId, module);

    try {
      await sendModuleAccessOtpEmail(recipient.email, otp, recipient.name, MODULES[module]);
    } catch (emailErr) {
      console.error('⚠️  Failed to send module-access OTP email:', emailErr.message);
    }

    await _auditLog(userId, 'otp_generated', module, req.ip);

    return res.status(200).json({
      success: true,
      message: `A verification code has been sent to your registered email. It expires in ${ModuleOtp.OTP_EXPIRY_MINUTES} minutes.`,
      expires_in_minutes: ModuleOtp.OTP_EXPIRY_MINUTES,
      resend_cooldown_seconds: ModuleOtp.RESEND_COOLDOWN_SECONDS,
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/module-otp/verify ───────────────────────────────────────
// Requires auth (staff only). Verifies the OTP the user submitted.
const verifyOtp = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const role   = req.user.role || '';
    const module = String(req.body.module || '');
    const { otp } = req.body;

    if (role === 'client') {
      return res.status(403).json({ success: false, message: 'Access denied. Staff only.' });
    }
    if (!MODULES[module]) {
      return res.status(400).json({ success: false, message: 'Unknown module.' });
    }
    if (!roleAllowedForModule(role, module)) {
      return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions for this module.' });
    }
    if (!otp || otp.length !== 6 || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid 6-digit code.' });
    }

    const result = await ModuleOtp.verify(userId, otp);

    if (!result.valid) {
      // Best-effort security event: a single failure is LOW (logged only);
      // repeated failures auto-escalate to a tracked incident + CD alert.
      securityEvents.record({
        module, eventType: 'module_otp_failure',
        userId, ip: req.ip, subjectKind: req.user.type === 'staff' ? 'staff' : 'user',
        details: `Module-access OTP verification failed for "${MODULES[module]}".`,
      }).catch(() => {});
      return res.status(400).json({ success: false, message: result.reason });
    }

    await _auditLog(userId, 'otp_verification_success', module, req.ip);
    await _auditLog(userId, 'module_access_granted', module, req.ip);

    return res.status(200).json({ success: true, message: 'Verified.' });
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
