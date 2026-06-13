const bcrypt = require('bcryptjs'); // pure-JS bcrypt — no native binary (avoids ELF header issues)
const jwt = require('jsonwebtoken');
const Staff = require('../models/Staff');
const LoginAttempt = require('../models/LoginAttempt');

// Keep the existing hashing strength — do NOT weaken.
const SALT_ROUNDS = 12;

// Generic responses — never reveal which part of the attempt failed.
const INVALID_CREDENTIALS = 'Invalid credentials.';

const getClientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim()
  || req.ip
  || req.connection?.remoteAddress
  || null;

const fullName = (staff) =>
  [staff.first_name, staff.last_name].filter(Boolean).join(' ').trim() || staff.username;

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

    if (!staff || !staff.is_active) {
      // For an inactive account we run the bcrypt path-less fail so timing is
      // similar, but still hide the reason. (Inactive accounts simply cannot
      // sign in regardless of password.)
      return await failGeneric();
    }

    const isMatch = await bcrypt.compare(password, staff.password_hash);
    if (!isMatch) {
      return await failGeneric();
    }

    // ── Success — reset the failed-attempt counter ──
    await LoginAttempt.clearFailedAttempts(username);

    const payload = {
      id: staff.staff_id,
      username: staff.username,
      role: staff.role,
      type: 'staff',
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
          id: staff.staff_id,
          full_name: fullName(staff),
          username: staff.username,
          email: staff.email,
          role: staff.role,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { login, SALT_ROUNDS };
