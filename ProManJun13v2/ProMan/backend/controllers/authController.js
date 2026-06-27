const bcrypt = require('bcryptjs'); // pure-JS bcrypt — no native binary (avoids 'invalid ELF header' on platform/Node mismatch)
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Staff = require('../models/Staff');
const { invalidateAccountCache } = require('../middleware/auth');
const Verification = require('../models/Verification');
const PasswordReset = require('../models/PasswordReset');
const LoginAttempt = require('../models/LoginAttempt');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/emailService');
const { validateClearance } = require('./captchaController');
const securityEvents = require('../services/securityEvents');

// Number of failed attempts before CAPTCHA is required (lower than MAX_FAILED_ATTEMPTS=5 lockout)
const CAPTCHA_REQUIRED_AFTER = 3;

// Validates the server-signed clearance token issued by /api/captcha/verify.
// This avoids a second round-trip to Google (reCAPTCHA tokens are single-use).
function _verifyCaptchaToken(clearanceToken) {
  const SKIP = process.env.RECAPTCHA_SKIP_VERIFY === 'true' || !process.env.RECAPTCHA_SECRET_KEY;
  if (SKIP) return true;
  if (!clearanceToken) return false;
  const payload = validateClearance(clearanceToken);
  return payload !== null; // valid, non-expired server-signed token
}

const SALT_ROUNDS = 12;
const OTP_EXPIRY_MINUTES = 2; // verification code is valid for 2 minutes
const OTP_RESEND_COOLDOWN_SECONDS = 120; // must wait 2 minutes between resend requests
const RESET_TOKEN_EXPIRY_MINUTES = 30;
const FRONTEND_BASE_URL = process.env.FRONTEND_URL || 'http://localhost:5500';

/**
 * Generate a cryptographically random 6-digit OTP.
 */
const generateOTP = () => {
  return crypto.randomInt(100000, 999999).toString();
};

/**
 * Generate a cryptographically secure reset token.
 */
const generateResetToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Mask an email for safe display in the verification prompt (e.g. j***@x.com).
const maskEmail = (email) => {
  if (!email || !email.includes('@')) return email || '';
  const [local, domain] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
};

// ── POST /api/auth/register ──────────────────────────

const register = async (req, res, next) => {
  try {
    const { full_name, email, password, contact_number } = req.body;

    // Check if email already exists
    const existingUser = await User.findByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists',
      });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user (unverified by default)
    const newUser = await User.create({
      full_name,
      email,
      password: hashedPassword,
      contact_number,
    });

    // Generate OTP, hash it, and store
    const otp = generateOTP();
    const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await Verification.create(newUser.id, otpHash, expiresAt);

    // Send verification email
    try {
      await sendVerificationEmail(email, otp, full_name);
    } catch (emailError) {
      console.error('⚠️  Failed to send verification email:', emailError.message);
      // Don't fail registration — user can request a new OTP later
    }

    return res.status(201).json({
      success: true,
      message: 'User registered successfully. Please check your email for the verification code.',
      data: {
        user: newUser,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/login ─────────────────────────────

const login = async (req, res, next) => {
  try {
    const { email, password, captcha_clearance } = req.body;
    const clientIp = req.ip || req.connection?.remoteAddress || null;

    // ── Step 1: Check for active account lockout ──
    const activeLock = await LoginAttempt.getActiveLock(email);
    if (activeLock) {
      const lockedUntil = new Date(activeLock.locked_until);
      const remainingMs = lockedUntil.getTime() - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60000);

      console.log(`🔒 Login blocked (locked): ${email} — ${remainingMinutes} min remaining`);

      return res.status(423).json({
        success: false,
        message: `Account is temporarily locked due to multiple failed login attempts. Please try again in ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}.`,
        locked: true,
        locked_until: lockedUntil.toISOString(),
        remaining_minutes: remainingMinutes,
      });
    }

    // ── Step 1b: Enforce CAPTCHA after CAPTCHA_REQUIRED_AFTER failures ──
    const preCheckCount = await LoginAttempt.getRecentFailedCount(email);
    if (preCheckCount >= CAPTCHA_REQUIRED_AFTER) {
      const captchaOk = _verifyCaptchaToken(captcha_clearance);
      if (!captchaOk) {
        return res.status(428).json({
          success: false,
          message: 'Please complete the security verification to continue.',
          captcha_required: true,
        });
      }
    }

    // ── Step 2: Find user by email ──
    const user = await User.findByEmail(email);
    if (!user) {
      // Record failed attempt even for non-existent emails (prevents enumeration timing attacks)
      await LoginAttempt.recordFailedAttempt(email, clientIp);
      const failedCount = await LoginAttempt.getRecentFailedCount(email);

      if (failedCount >= LoginAttempt.MAX_FAILED_ATTEMPTS) {
        const lockedUntil = await LoginAttempt.lockAccount(email, clientIp);
        return res.status(423).json({
          success: false,
          message: `Account has been temporarily locked due to ${LoginAttempt.MAX_FAILED_ATTEMPTS} failed login attempts. Please try again in ${LoginAttempt.LOCKOUT_DURATION_MINUTES} minutes.`,
          locked: true,
          locked_until: lockedUntil.toISOString(),
          remaining_minutes: LoginAttempt.LOCKOUT_DURATION_MINUTES,
        });
      }

      const attemptsRemaining = LoginAttempt.MAX_FAILED_ATTEMPTS - failedCount;
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
        attempts_remaining: attemptsRemaining,
        captcha_required: failedCount >= CAPTCHA_REQUIRED_AFTER,
      });
    }

    // ── Step 2b: Block suspended accounts ──
    // A Clinical Director can suspend a client from the Action Center; that sets
    // users.is_active = FALSE and must prevent any further login.
    if (user.is_active === false) {
      securityEvents.record({
        module: 'user_access', eventType: 'suspicious_account_activity',
        userId: user.id, ip: clientIp, subjectKind: 'user',
        details: `Login attempt on suspended account ${email}.`,
      });
      return res.status(403).json({
        success: false,
        suspended: true,
        message: 'Your account has been suspended. Please contact the moderator.',
      });
    }

    // ── Step 3: Check if email is verified ──
    if (!user.is_verified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email before logging in. Check your inbox for the verification code.',
      });
    }

    // ── Step 4: Compare passwords ──
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      // Record the failed attempt
      await LoginAttempt.recordFailedAttempt(email, clientIp);

      // Check if threshold is now exceeded
      const failedCount = await LoginAttempt.getRecentFailedCount(email);

      // Action Center tracking: a Failed Login Attempt incident is opened only
      // once the user has failed 3 times (not on every attempt). The 3rd failure
      // opens a tracked MEDIUM incident; further failures dedupe into it.
      // Individual attempts still appear in Audit Logs via login_attempts.
      const FAILED_LOGIN_TRACK_AT = 3;
      if (failedCount >= FAILED_LOGIN_TRACK_AT) {
        securityEvents.record({
          module: 'user_access', eventType: 'failed_login',
          userId: user.id, ip: clientIp, subjectKind: 'user',
          severityOverride: 'medium',
          details: `${failedCount} failed login attempts for ${email}.`,
        });
      }

      if (failedCount >= LoginAttempt.MAX_FAILED_ATTEMPTS) {
        // Lock the account
        const lockedUntil = await LoginAttempt.lockAccount(email, clientIp);
        const remainingMinutes = LoginAttempt.LOCKOUT_DURATION_MINUTES;

        securityEvents.record({
          module: 'user_access', eventType: 'account_lockout',
          userId: user.id, ip: clientIp, subjectKind: 'user',
          details: `Account ${email} locked after ${LoginAttempt.MAX_FAILED_ATTEMPTS} failed attempts.`,
        });

        return res.status(423).json({
          success: false,
          message: `Account has been temporarily locked due to ${LoginAttempt.MAX_FAILED_ATTEMPTS} failed login attempts. Please try again in ${remainingMinutes} minutes.`,
          locked: true,
          locked_until: lockedUntil.toISOString(),
          remaining_minutes: remainingMinutes,
        });
      }

      const attemptsRemaining = LoginAttempt.MAX_FAILED_ATTEMPTS - failedCount;
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
        attempts_remaining: attemptsRemaining,
        captcha_required: failedCount >= CAPTCHA_REQUIRED_AFTER,
      });
    }

    // ── Step 5: Password OK — clear failed attempts ──
    await LoginAttempt.clearFailedAttempts(email);

    // ── Step 6: Second factor — email a one-time code on EVERY login ──
    // No JWT is issued yet. A 6-digit code (valid 2 minutes) is emailed and
    // must be confirmed via /verify-login-otp before a session is granted.
    try {
      const otp = generateOTP();
      const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
      const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
      await Verification.create(user.id, otpHash, expiresAt);
      await sendVerificationEmail(user.email, otp, user.full_name);
    } catch (emailError) {
      console.error('⚠️  Failed to send login verification email:', emailError.message);
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
        email: user.email,
        email_hint: maskEmail(user.email),
        expires_in_minutes: OTP_EXPIRY_MINUTES,
        // A code was just sent, so the 2-minute resend cooldown starts now.
        resend_cooldown_seconds: OTP_RESEND_COOLDOWN_SECONDS,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/verify-login-otp ───────────────────
// Confirms the emailed code for an already-verified account that is logging
// in, and issues the session JWT. (Distinct from /verify-email, which is the
// one-time registration confirmation that flips is_verified.)
const verifyLoginOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    const user = await User.findByEmail(email);
    const invalid = () =>
      res.status(400).json({ success: false, message: 'Invalid code. Please try again.' });

    if (!user) return invalid();

    const verification = await Verification.findByUserId(user.id);
    if (!verification) return invalid();

    if (new Date() > new Date(verification.expires_at)) {
      await Verification.deleteByUserId(user.id);
      return res.status(400).json({
        success: false,
        message: 'Code has expired. Please request a new one.',
      });
    }

    const isValid = await bcrypt.compare(String(otp || ''), verification.otp_hash);
    if (!isValid) return invalid();

    // Single-use: consume the code, then issue the session token.
    await Verification.deleteByUserId(user.id);

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      // Force Password Reset (Action Center): after OTP, the client is sent to
      // the reset-password page instead of the dashboard. No email is involved.
      must_reset_password: user.must_reset_password === true,
      data: {
        token,
        must_reset_password: user.must_reset_password === true,
        user: {
          id: user.id,
          full_name: user.full_name,
          email: user.email,
          contact_number: user.contact_number,
          role: user.role,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/force-reset-password ───────────────
// Authenticated reset for a client flagged with must_reset_password (set by the
// Clinical Director's "Force Password Reset" action). No email token is used —
// the just-logged-in session authorizes the change. Clears the flag and ends
// other sessions on success.
const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;
const forceResetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (req.user.type === 'staff') {
      return res.status(400).json({ success: false, message: 'Not applicable to staff accounts.' });
    }
    const user = await User.findByEmail(req.user.email);
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
    if (!user.must_reset_password) {
      return res.status(400).json({ success: false, message: 'No password reset is required for this account.' });
    }
    if (!password || !PASSWORD_RULE.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 12 characters and include upper, lower, a number and a special character.',
      });
    }
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    await User.updatePassword(user.id, hashedPassword);
    await User.setMustResetPassword(user.id, false);
    // End any other active sessions so the new password is required everywhere.
    await User.invalidateSessions(user.id);
    return res.status(200).json({ success: true, message: 'Password updated. Please sign in with your new password.' });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/resend-login-otp ───────────────────
// Re-sends a fresh login code for an in-progress login, with the same
// server-enforced 2-minute cooldown as registration.
const resendLoginOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findByEmail(email);

    if (user) {
      // Resend rate limit: first resend is free, then a 2-minute cooldown.
      const rs = await Verification.resendStatus(user.id, OTP_RESEND_COOLDOWN_SECONDS);
      if (!rs.allowed) {
        return res.status(429).json({
          success: false,
          message: `Please wait ${rs.retryAfter} second(s) before requesting another code.`,
          retryAfter: rs.retryAfter,
        });
      }
      try {
        const otp = generateOTP();
        const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
        await Verification.create(user.id, otpHash, expiresAt);
        await sendVerificationEmail(user.email, otp, user.full_name);
      } catch (emailError) {
        console.error('⚠️  Failed to resend login verification email:', emailError.message);
      }
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

// ── POST /api/auth/verify-email ──────────────────────

const verifyEmail = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    // Find the user
    const user = await User.findByEmail(email);
    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email or verification code',
      });
    }

    // Already verified?
    if (user.is_verified) {
      return res.status(400).json({
        success: false,
        message: 'Email is already verified',
      });
    }

    // Find verification record
    const verification = await Verification.findByUserId(user.id);
    if (!verification) {
      return res.status(400).json({
        success: false,
        message: 'No verification code found. Please register again.',
      });
    }

    // Check expiry
    if (new Date() > new Date(verification.expires_at)) {
      await Verification.deleteByUserId(user.id);
      return res.status(400).json({
        success: false,
        message: 'Code has expired. Please request a new one.',
      });
    }

    // Compare OTP
    const isValid = await bcrypt.compare(otp, verification.otp_hash);
    if (!isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid code. Please try again.',
      });
    }

    // Mark user as verified and delete the OTP (single-use)
    await User.markAsVerified(user.id);
    await Verification.deleteByUserId(user.id);

    return res.status(200).json({
      success: true,
      message: 'Email verified successfully. You can now log in.',
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/resend-otp ────────────────────────

const resendOtp = async (req, res, next) => {
  try {
    const { email } = req.body;

    // Find the user
    const user = await User.findByEmail(email);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No account found with this email address.',
      });
    }

    // Already verified?
    if (user.is_verified) {
      return res.status(400).json({
        success: false,
        message: 'Email is already verified. You can log in.',
      });
    }

    // Resend rate limit: first resend is free, then a 2-minute cooldown.
    const rs = await Verification.resendStatus(user.id, OTP_RESEND_COOLDOWN_SECONDS);
    if (!rs.allowed) {
      return res.status(429).json({
        success: false,
        message: `Please wait ${rs.retryAfter} second(s) before requesting another code.`,
        retryAfter: rs.retryAfter,
      });
    }

    // Generate new OTP, hash it, and store (replaces old ones)
    const otp = generateOTP();
    const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await Verification.create(user.id, otpHash, expiresAt);

    // Send verification email
    try {
      await sendVerificationEmail(email, otp, user.full_name);
    } catch (emailError) {
      console.error('⚠️  Failed to send verification email:', emailError.message);
    }

    return res.status(200).json({
      success: true,
      message: 'A new verification code has been sent to your email.',
      retryAfter: OTP_RESEND_COOLDOWN_SECONDS,
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/forgot-password ───────────────────

const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    // Always return success to prevent email enumeration
    const user = await User.findByEmail(email);
    if (!user) {
      return res.status(200).json({
        success: true,
        message: 'If an account with that email exists, a password reset link has been sent.',
      });
    }

    // Generate token, hash, and store
    const token = generateResetToken();
    const tokenHash = await bcrypt.hash(token, SALT_ROUNDS);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000);

    await PasswordReset.create(user.id, tokenHash, expiresAt);

    // Build reset URL. Prefer an explicit FRONTEND_URL; otherwise derive it from
    // the request origin so the emailed link always points to wherever the app is
    // actually served (the backend serves the frontend), instead of a fixed port.
    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${baseUrl}/reset-password.html?token=${token}`;

    // Send email
    try {
      await sendPasswordResetEmail(user.email, resetUrl, user.full_name);
    } catch (emailError) {
      console.error('⚠️  Failed to send password reset email:', emailError.message);
    }

    return res.status(200).json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/reset-password ────────────────────

const resetPassword = async (req, res, next) => {
  try {
    const { token, password } = req.body;

    // Find all valid (non-expired, non-used) reset records
    const records = await PasswordReset.findAllValid();

    // Iterate and compare hashed tokens
    let matchedRecord = null;
    for (const record of records) {
      const isMatch = await bcrypt.compare(token, record.token_hash);
      if (isMatch) {
        matchedRecord = record;
        break;
      }
    }

    if (!matchedRecord) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset link. Please request a new one.',
      });
    }

    // Hash the new password and update user
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    await User.updatePassword(matchedRecord.user_id, hashedPassword);

    // Mark token as used
    await PasswordReset.markUsed(matchedRecord.id);

    return res.status(200).json({
      success: true,
      message: 'Password has been reset successfully. You can now log in with your new password.',
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/auth/verify-token ───────────────────────
// Acts as the trusted "/me": returns the identity derived from the *verified*
// JWT (never from client storage). The frontend uses this — not sessionStorage —
// for all authorization/UI decisions.
const verifyToken = (req, res) => {
  // req.user is set by the authenticate middleware
  return res.status(200).json({
    success: true,
    message: 'Token is valid',
    data: {
      user: req.user,
    },
  });
};

// ── POST /api/auth/logout ────────────────────────────
// Real, server-side logout: invalidates every token issued before "now" for the
// authenticated account (sets sessions_invalid_after = NOW()). Combined with the
// authenticate middleware's session-termination check, the just-used token — and
// any other outstanding token for this account — becomes unusable immediately.
// Works for both client and staff tokens (branches on token type).
const logout = async (req, res, next) => {
  try {
    const { id, type } = req.user || {};
    if (id != null) {
      if (type === 'staff') {
        await Staff.invalidateSessions(id);
      } else {
        await User.invalidateSessions(id);
      }
      // Drop the cached account status so the revocation is effective instantly
      // rather than after the cache TTL.
      try { invalidateAccountCache(type, id); } catch (_) {}
    }
    return res.status(200).json({ success: true, message: 'Logged out.' });
  } catch (error) {
    next(error);
  }
};

module.exports = { register, login, verifyEmail, resendOtp, verifyLoginOtp, resendLoginOtp, forgotPassword, resetPassword, forceResetPassword, verifyToken, logout };

