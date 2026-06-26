const jwt = require('jsonwebtoken');
const Staff = require('../models/Staff');
const User = require('../models/User');

// A JWT is rejected if it was issued before the account's sessions_invalid_after
// instant. decoded.iat is in seconds; the column is a timestamp.
function sessionTerminated(decoded, invalidAfter) {
  if (!invalidAfter) return false;
  const issuedMs = (decoded.iat || 0) * 1000;
  return issuedMs < new Date(invalidAfter).getTime();
}

/**
 * JWT authentication middleware.
 * Extracts the Bearer token from the Authorization header, verifies it, and
 * attaches the decoded payload to req.user.
 *
 * For STAFF tokens (payload.type === 'staff') it additionally re-checks the
 * account's current `is_active` flag against the database on every request.
 * This is what makes a deactivation take effect immediately: once the Clinical
 * Director deactivates an account, the staff member's existing (still
 * cryptographically valid) token is rejected on its very next request, so the
 * frontend session guard logs them out automatically.
 */
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No token provided.',
    });
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token.',
    });
  }

  req.user = { id: decoded.id, email: decoded.email, role: decoded.role, type: decoded.type };

  // Live deactivation / session-termination check for staff accounts.
  if (decoded.type === 'staff') {
    try {
      const staff = await Staff.findById(decoded.id);
      if (!staff || !staff.is_active) {
        return res.status(401).json({
          success: false,
          message: 'Your account has been suspended. Please contact the moderator.',
          deactivated: true,
        });
      }
      if (sessionTerminated(decoded, staff.sessions_invalid_after)) {
        return res.status(401).json({
          success: false,
          message: 'Your session has ended. Please sign in again.',
          session_terminated: true,
        });
      }
    } catch (err) {
      return next(err);
    }
  } else {
    // Live suspension / session-termination check for client accounts. This is
    // what makes "Suspend Account" and "Require MFA Authentication" take effect
    // in real time: an existing token is rejected on its very next request.
    try {
      const user = await User.findById(decoded.id);
      if (!user || user.is_active === false) {
        return res.status(401).json({
          success: false,
          message: 'Your account has been suspended. Please contact the moderator.',
          deactivated: true,
        });
      }
      if (sessionTerminated(decoded, user.sessions_invalid_after)) {
        return res.status(401).json({
          success: false,
          message: 'Your session has ended. Please sign in again.',
          session_terminated: true,
        });
      }
    } catch (err) {
      return next(err);
    }
  }

  next();
};

// Optional authentication — attaches req.user if a valid token is present,
// but does NOT reject requests that have no token (used for audit endpoints
// that should work whether the caller is logged in or not).
const optionalAuthenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id, email: decoded.email, role: decoded.role, type: decoded.type };
  } catch (_) {
    // Invalid token — treat as unauthenticated, do not reject
  }
  next();
};

module.exports = { authenticate, optionalAuthenticate };
