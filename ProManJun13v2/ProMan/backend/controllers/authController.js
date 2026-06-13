const bcrypt = require('bcryptjs'); // pure-JS bcrypt — no native binary (avoids 'invalid ELF header' on platform/Node mismatch)
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Verification = require('../models/Verification');
const PasswordReset = require('../models/PasswordReset');
const LoginAttempt = require('../models/LoginAttempt');
const { sendVerificationEmail } = require('../services/emailService');
const { sendPasswordResetEmail } = require('../services/emailService');

const SALT_ROUNDS = 12;
const OTP_EXPIRY_MINUTES = 15;
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
    const { email, password } = req.body;
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

      if (failedCount >= LoginAttempt.MAX_FAILED_ATTEMPTS) {
        // Lock the account
        const lockedUntil = await LoginAttempt.lockAccount(email, clientIp);
        const remainingMinutes = LoginAttempt.LOCKOUT_DURATION_MINUTES;

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
      });
    }

    // ── Step 5: Successful login — clear failed attempts ──
    await LoginAttempt.clearFailedAttempts(email);

    // Generate JWT
    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '1h',
    });

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
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
        message: 'Verification code has expired. Please register again to receive a new code.',
      });
    }

    // Compare OTP
    const isValid = await bcrypt.compare(otp, verification.otp_hash);
    if (!isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email or verification code',
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

module.exports = { register, login, verifyEmail, resendOtp, forgotPassword, resetPassword, verifyToken };

