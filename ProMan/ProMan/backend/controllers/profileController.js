const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db     = require('../config/db');
const User   = require('../models/User');
const { Profile, PrivacySettings } = require('../models/Profile');
const AuditLog = require('../models/AuditLog');
const Verification = require('../models/Verification');
const PasswordReset = require('../models/PasswordReset');
const { sendVerificationEmail } = require('../services/emailService');
const { sendPasswordResetEmail } = require('../services/emailService');

const SALT_ROUNDS = 12;
const OTP_EXPIRY_MINUTES = 15;
const RESET_TOKEN_EXPIRY_MINUTES = 30;
const FRONTEND_BASE_URL = process.env.FRONTEND_URL || 'http://localhost:5500';

const generateOTP = () => crypto.randomInt(100000, 999999).toString();
const generateResetToken = () => crypto.randomBytes(32).toString('hex');

/**
 * Helper: get client IP from request.
 */
const getClientIP = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.connection?.remoteAddress
    || req.ip
    || 'unknown';
};

// ── GET /api/profile ─────────────────────────────────

const getProfile = async (req, res, next) => {
  try {
    const profile = await Profile.findByUserId(req.user.id);

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'Profile not found.',
      });
    }

    // Build clean response
    const data = {
      id:             profile.id,
      full_name:      profile.full_name,
      email:          profile.email,
      contact_number: profile.contact_number,
      is_verified:    profile.is_verified,
      gender:         profile.gender || null,
      date_of_birth:  profile.date_of_birth || null,
      civil_status:   profile.civil_status || null,
      address:        profile.address || null,
      medical_history:     profile.medical_history || null,
      current_medications: profile.current_medications || null,
      previous_treatments: profile.previous_treatments || null,
      privacy: {
        show_contact_number:      profile.show_contact_number ?? false,
        show_date_of_birth:       profile.show_date_of_birth ?? false,
        show_address:             profile.show_address ?? false,
        show_medical_history:     profile.show_medical_history ?? false,
        show_current_medications: profile.show_current_medications ?? false,
        show_previous_treatments: profile.show_previous_treatments ?? false,
      },
      created_at:         profile.created_at,
      profile_updated_at: profile.profile_updated_at || null,
    };

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/profile/verify-password ────────────────

const verifyPassword = async (req, res, next) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required.',
      });
    }

    const user = await User.findByIdWithPassword(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Incorrect password.',
      });
    }

    return res.status(200).json({ success: true, message: 'Password verified.' });
  } catch (error) {
    next(error);
  }
};

// ── PUT /api/profile ─────────────────────────────────

const updateProfile = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const ipAddress = getClientIP(req);

    // Fetch current state for diffing
    const current = await Profile.findByUserId(userId);
    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    const {
      full_name, email, contact_number,
      gender, date_of_birth, civil_status, address,
      medical_history, current_medications, previous_treatments,
      privacy,
    } = req.body;

    const changes = [];
    let emailChanged = false;

    // ── Core user fields (update users table) ─────────
    if (full_name !== undefined && full_name !== current.full_name) {
      changes.push({ field: 'full_name', oldValue: current.full_name, newValue: full_name });
      await User.updateField(userId, 'full_name', full_name);
    }

    if (contact_number !== undefined && contact_number !== current.contact_number) {
      changes.push({ field: 'contact_number', oldValue: current.contact_number, newValue: contact_number });
      await User.updateField(userId, 'contact_number', contact_number);
    }

    // ── Email change (triggers re-verification) ───────
    if (email !== undefined && email !== current.email) {
      // Password is required for email change
      const { password } = req.body;
      if (!password) {
        return res.status(400).json({
          success: false,
          message: 'Password is required to change your email.',
        });
      }

      const user = await User.findByIdWithPassword(userId);
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: 'Incorrect password.',
        });
      }

      // Check if new email is already taken
      const existing = await User.findByEmail(email);
      if (existing && existing.id !== userId) {
        return res.status(409).json({
          success: false,
          message: 'This email address is already in use.',
        });
      }

      changes.push({ field: 'email', oldValue: current.email, newValue: email });
      await User.updateField(userId, 'email', email);
      await User.markAsUnverified(userId);
      emailChanged = true;

      // Generate OTP and send verification to the NEW email
      const otp = generateOTP();
      const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
      const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
      await Verification.create(userId, otpHash, expiresAt);

      try {
        await sendVerificationEmail(email, otp, current.full_name);
      } catch (emailError) {
        console.error('⚠️  Failed to send verification email:', emailError.message);
      }
    }

    // ── Profile fields (upsert user_profiles) ─────────
    const profileFields = {
      gender, date_of_birth, civil_status, address,
      medical_history, current_medications, previous_treatments,
    };

    // Track changes for profile fields
    const profileFieldNames = ['gender', 'date_of_birth', 'civil_status', 'address',
      'medical_history', 'current_medications', 'previous_treatments'];

    for (const field of profileFieldNames) {
      if (profileFields[field] !== undefined) {
        const oldVal = current[field] != null ? String(current[field]) : null;
        const newVal = profileFields[field] != null ? String(profileFields[field]) : null;
        if (oldVal !== newVal) {
          changes.push({ field, oldValue: oldVal, newValue: newVal });
        }
      }
    }

    // Only upsert if at least one profile field was provided
    const hasProfileUpdate = profileFieldNames.some(f => profileFields[f] !== undefined);
    if (hasProfileUpdate) {
      await Profile.upsert(userId, profileFields);
    }

    // ── Privacy settings ──────────────────────────────
    if (privacy && typeof privacy === 'object') {
      await PrivacySettings.upsert(userId, privacy);

      // Track privacy changes
      const privacyFields = ['show_contact_number', 'show_date_of_birth', 'show_address',
        'show_medical_history', 'show_current_medications', 'show_previous_treatments'];
      for (const field of privacyFields) {
        if (privacy[field] !== undefined) {
          const oldVal = current[field] != null ? String(current[field]) : 'false';
          const newVal = String(privacy[field]);
          if (oldVal !== newVal) {
            changes.push({ field: `privacy.${field}`, oldValue: oldVal, newValue: newVal });
          }
        }
      }
    }

    // ── Log all changes ───────────────────────────────
    if (changes.length > 0) {
      await AuditLog.log(userId, changes, ipAddress);
    }

    // Fetch updated profile
    const updated = await Profile.findByUserId(userId);

    const responseData = {
      message: emailChanged
        ? 'Profile updated. A verification code has been sent to your new email.'
        : 'Profile updated successfully.',
      changes_logged: changes.length,
    };

    return res.status(200).json({ success: true, ...responseData });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/profile ──────────────────────────────

const deleteProfile = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const userId = req.user.id;
    const ipAddress = getClientIP(req);

    // Password is required for account deletion
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required to delete your account.',
      });
    }

    const user = await User.findByIdWithPassword(userId);
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      client.release();
      return res.status(401).json({
        success: false,
        message: 'Incorrect password.',
      });
    }

    await client.query('BEGIN');

    // Log the deletion audit entry FIRST (before cascade removes FKs)
    await AuditLog.logWithClient(client, userId,
      [{ field: 'account', oldValue: 'active', newValue: 'deleted' }],
      ipAddress
    );

    // Delete the user — ON DELETE CASCADE handles profiles, privacy, verifications, and audit logs
    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      message: 'Account and all associated data have been permanently deleted.',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

// ── POST /api/profile/change-password ────────────────

const changePassword = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const user = await User.findByIdWithPassword(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    // Generate token, hash, and store
    const token = generateResetToken();
    const tokenHash = await bcrypt.hash(token, SALT_ROUNDS);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000);

    await PasswordReset.create(userId, tokenHash, expiresAt);

    // Build reset URL and send email
    const resetUrl = `${FRONTEND_BASE_URL}/reset-password.html?token=${token}`;

    try {
      await sendPasswordResetEmail(user.email, resetUrl, user.full_name);
    } catch (emailError) {
      console.error('⚠️  Failed to send password reset email:', emailError.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to send reset email. Please try again.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'A password reset link has been sent to your email.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getProfile, verifyPassword, updateProfile, deleteProfile, changePassword };
