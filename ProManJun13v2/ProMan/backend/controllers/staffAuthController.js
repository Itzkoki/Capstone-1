const bcrypt = require('bcryptjs'); // pure-JS bcrypt — no native binary (avoids ELF header issues)
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Staff = require('../models/Staff');
const StaffVerification = require('../models/StaffVerification');
const StaffPasswordReset = require('../models/StaffPasswordReset');
const LoginAttempt = require('../models/LoginAttempt');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/emailService');
const { makeFingerprint, setFingerprintCookie } = require('../utils/tokenBinding');

// Keep the existing hashing strength — do NOT weaken.
const SALT_ROUNDS = 12;
// OTP rules (kept identical to the client flow): a code is valid for exactly
// 2 minutes, and a fresh resend is only permitted once every 2 minutes.
const OTP_EXPIRY_MINUTES = 2;
const OTP_RESEND_COOLDOWN_SECONDS = 120;

// Generic responses — never reveal which part of the attempt failed.
const INVALID_CREDENTIALS = 'Invalid credentials.';

const getClientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim()
  || req.ip
  || req.connection?.remoteAddress
  || null;

const fullName = (staff) =>
  [staff.first_name, staff.last_name].filter(Boolean).join(' ').trim() || staff.username;

const generateOTP = () => crypto.randomInt(100000, 999999).toString();
const generateResetToken = () => crypto.randomBytes(32).toString('hex');
// A staff reset link is valid for 30 minutes (matches the client flow).
const RESET_TOKEN_EXPIRY_MINUTES = 30;
// Same policy the reset page enforces client-side — re-checked here so the API
// can't be called directly with a weak password.
const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;

// Issue the final JWT + user payload after both factors pass. `fpHash` binds the
// token to the HttpOnly fingerprint cookie set by the caller (replay defense).
const issueSession = (staff, fpHash) => {
  const token = jwt.sign(
    { id: staff.staff_id, username: staff.username, role: staff.role, type: 'staff', fp: fpHash },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
  return {
    token,
    user: {
      id: staff.staff_id,
      full_name: fullName(staff),
      username: staff.username,
      email: staff.email,
      role: staff.role,
    },
  };
};

// Generate + store + email a fresh one-time code for the staff member.
const sendStaffOtp = async (staff) => {
  const otp = generateOTP();
  const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
  await StaffVerification.create(staff.staff_id, otpHash, expiresAt);
  await sendVerificationEmail(staff.email, otp, fullName(staff));
};

// Mask an email for safe display in the verification prompt (e.g. j***@x.com).
const maskEmail = (email) => {
  if (!email || !email.includes('@')) return email || '';
  const [local, domain] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
};

// ── POST /api/staff-auth/login ───────────────────────────
// Login-only: there is NO public staff registration. Accounts are created
// through the internal, authenticated management flow.
const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const clientIp = getClientIp(req);

    // ── Per-account lockout pre-check (keyed by username) ──
    const activeLock = await LoginAttempt.getActiveLock(username);
    if (activeLock) {
      const remainingMs = new Date(activeLock.locked_until).getTime() - Date.now();
      const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
      return res.status(423).json({
        message: `Account is temporarily locked due to multiple failed login attempts. Please try again in ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}.`,
      });
    }

    // Look up the account. We deliberately keep the SAME response for
    // "no such user", "inactive", and "wrong password" to prevent enumeration.
    const staff = await Staff.findByUsername(username);

    // Helper: record a failed attempt and lock after the threshold, then
    // respond with the generic message.
    const failGeneric = async () => {
      await LoginAttempt.recordFailedAttempt(username, clientIp);
      const failedCount = await LoginAttempt.getRecentFailedCount(username);
      if (failedCount >= LoginAttempt.MAX_FAILED_ATTEMPTS) {
        await LoginAttempt.lockAccount(username, clientIp);
        return res.status(423).json({
          message: `Account is temporarily locked due to multiple failed login attempts. Please try again in ${LoginAttempt.LOCKOUT_DURATION_MINUTES} minutes.`,
        });
      }
      return res.status(401).json({ message: INVALID_CREDENTIALS });
    };

    if (!staff) {
      // Unknown username — generic fail (anti-enumeration).
      return await failGeneric();
    }
    if (!staff.is_active) {
      // Suspended/deactivated account: tell the user explicitly so a CD-issued
      // suspension is clear (Action Center "Suspend Account").
      return res.status(403).json({
        suspended: true,
        message: 'Your account has been suspended. Please contact the moderator.',
      });
    }

    const isMatch = await bcrypt.compare(password, staff.password_hash);
    if (!isMatch) {
      return await failGeneric();
    }

    // ── Password OK — reset the failed-attempt counter ──
    await LoginAttempt.clearFailedAttempts(username);

    // ── Second factor: email verification code on EVERY login ──
    // We do NOT issue a JWT yet. A one-time code is emailed and must be
    // confirmed via /verify-otp before a session is granted. Accounts always
    // have an email (required at creation); if delivery fails we surface a
    // clear error rather than silently bypassing the second factor.
    try {
      await sendStaffOtp(staff);
    } catch (emailError) {
      console.error('⚠️  Failed to send staff verification email:', emailError.message);
      return res.status(502).json({
        success: false,
        message: 'We could not send your verification code. Please try again in a moment.',
      });
    }

    return res.status(200).json({
      success: true,
      requiresVerification: true,
      message: 'A verification code has been sent to your email.',
      data: {
        username: staff.username,
        email_hint: maskEmail(staff.email),
        expires_in_minutes: OTP_EXPIRY_MINUTES,
        // A code was just sent, so the 2-minute resend cooldown starts now.
        resend_cooldown_seconds: OTP_RESEND_COOLDOWN_SECONDS,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/staff-auth/verify-otp ──────────────────────
// Confirms the emailed code and, on success, issues the session JWT and
// promotes the account's status to 'verified'.
const verifyOtp = async (req, res, next) => {
  try {
    const { username, otp } = req.body;

    const staff = await Staff.findByUsername(username);
    // Enumeration-safe generic failure.
    const invalid = () =>
      res.status(400).json({ success: false, message: 'Invalid code. Please try again.' });

    if (!staff || !staff.is_active) return invalid();

    const record = await StaffVerification.findByStaffId(staff.staff_id);
    if (!record) return invalid();

    if (new Date() > new Date(record.expires_at)) {
      await StaffVerification.deleteByStaffId(staff.staff_id);
      return res.status(400).json({
        success: false,
        message: 'Code has expired. Please request a new one.',
      });
    }

    const isValid = await bcrypt.compare(String(otp || ''), record.otp_hash);
    if (!isValid) {
      // Per-code brute-force guard: count the wrong guess and invalidate the code
      // once too many have been made, forcing a fresh one (which resets the
      // counter). Complements the per-IP rate limiter and the OTP expiry.
      const attempts = await StaffVerification.incrementAttempts(record.id);
      if (attempts >= StaffVerification.MAX_OTP_ATTEMPTS) {
        await StaffVerification.deleteByStaffId(staff.staff_id);
        return res.status(400).json({
          success: false,
          message: 'Too many incorrect attempts. Please request a new code.',
        });
      }
      return invalid();
    }

    // Single-use: consume the code, and promote status to 'verified'.
    await StaffVerification.deleteByStaffId(staff.staff_id);
    const verified = await Staff.markVerified(staff.staff_id);

    // Bind the staff token to an HttpOnly fingerprint cookie (replay defense).
    const fp = makeFingerprint();
    setFingerprintCookie(req, res, fp.raw);

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      data: issueSession(verified || staff, fp.hash),
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/staff-auth/resend-otp ──────────────────────
// Re-sends a fresh code for an in-progress login. Generic response to avoid
// account enumeration.
const resendOtp = async (req, res, next) => {
  try {
    const { username } = req.body;
    const staff = await Staff.findByUsername(username);
    if (staff && staff.is_active && staff.email) {
      // Resend rate limit: first resend is free, then a 2-minute cooldown
      // (matches the Teleconference OTP workflow). Enforced server-side.
      const rs = await StaffVerification.resendStatus(staff.staff_id, OTP_RESEND_COOLDOWN_SECONDS);
      if (!rs.allowed) {
        return res.status(429).json({
          success: false,
          message: `Please wait ${rs.retryAfter} second(s) before requesting another code.`,
          retryAfter: rs.retryAfter,
        });
      }
      try { await sendStaffOtp(staff); }
      catch (e) { console.error('⚠️  Failed to resend staff OTP:', e.message); }
    }
    return res.status(200).json({
      success: true,
      message: 'If the account is valid, a new verification code has been sent.',
      retryAfter: OTP_RESEND_COOLDOWN_SECONDS,
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/staff-auth/forgot-password ─────────────────
// Emails a single-use reset link to a staff member. Always responds success to
// avoid revealing which emails belong to a staff account (enumeration-safe).
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const generic = {
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    };

    const staff = await Staff.findByEmail(email);
    // Only active accounts can reset; a suspended account must contact the CD.
    if (!staff || !staff.is_active) {
      return res.status(200).json(generic);
    }

    const token = generateResetToken();
    const tokenHash = await bcrypt.hash(token, SALT_ROUNDS);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000);
    await StaffPasswordReset.create(staff.staff_id, tokenHash, expiresAt);

    // Link points at the shared reset page in STAFF mode so it posts back to the
    // staff endpoint. Prefer FRONTEND_URL; else derive from the request origin.
    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${baseUrl}/reset-password.html?token=${token}&portal=staff`;

    try {
      await sendPasswordResetEmail(staff.email, resetUrl, fullName(staff));
    } catch (emailError) {
      console.error('⚠️  Failed to send staff password reset email:', emailError.message);
    }

    return res.status(200).json(generic);
  } catch (error) {
    next(error);
  }
};

// ── POST /api/staff-auth/reset-password ──────────────────
// Consumes a single-use token and sets a new staff password. Ends all other
// sessions so the new password is required everywhere.
const resetPassword = async (req, res, next) => {
  try {
    const { token, password } = req.body;

    if (!password || !PASSWORD_RULE.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 12 characters and include upper, lower, a number and a special character.',
      });
    }

    // Tokens are hashed at rest, so scan the valid set and bcrypt-compare.
    const records = await StaffPasswordReset.findAllValid();
    let matched = null;
    for (const record of records) {
      if (await bcrypt.compare(token || '', record.token_hash)) { matched = record; break; }
    }

    if (!matched) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset link. Please request a new one.',
      });
    }

    const staff = await Staff.findByIdWithPassword(matched.staff_id);
    // New password must differ from the current one.
    if (staff && staff.password_hash && await bcrypt.compare(password, staff.password_hash)) {
      return res.status(400).json({
        success: false,
        message: 'Your new password must be different from your previous password.',
      });
    }

    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    await Staff.updatePassword(matched.staff_id, hashed);
    await StaffPasswordReset.markUsed(matched.id);
    // Revoke every existing session so a leaked/older token can't stay signed in.
    try { await Staff.invalidateSessions(matched.staff_id); } catch (_) {}

    return res.status(200).json({
      success: true,
      message: 'Password has been reset successfully. You can now log in with your new password.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { login, verifyOtp, resendOtp, forgotPassword, resetPassword, SALT_ROUNDS };
