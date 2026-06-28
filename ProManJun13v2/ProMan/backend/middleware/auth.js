const jwt = require('jsonwebtoken');
const Staff = require('../models/Staff');
const User = require('../models/User');
const { fingerprintOk } = require('../utils/tokenBinding');

// A JWT is rejected if it was issued before the account's sessions_invalid_after
// instant. decoded.iat is in seconds; the column is a timestamp.
function sessionTerminated(decoded, invalidAfter) {
  if (!invalidAfter) return false;
  const issuedMs = (decoded.iat || 0) * 1000;
  return issuedMs < new Date(invalidAfter).getTime();
}

// ── Account-status cache (RTT optimization) ──────────────────────────────────
// Every authenticated request used to make a DB round-trip (Staff/User.findById)
// purely to re-check is_active + sessions_invalid_after. Staff modules fire many
// requests per screen, so that round-trip dominated their latency. We cache the
// minimal status fields per account for a few seconds: deactivation / logout
// still take effect almost immediately (within the TTL, and instantly for the
// acting account because logout clears its own entry), while the common case
// skips the query entirely.
const STATUS_TTL_MS = 15000;
const statusCache = new Map(); // key `${type}:${id}` -> { exp, is_active, sessions_invalid_after }

function cacheKey(type, id) {
  return `${type === 'staff' ? 'staff' : 'user'}:${id}`;
}

async function getAccountStatus(type, id) {
  const key = cacheKey(type, id);
  const hit = statusCache.get(key);
  if (hit && hit.exp > Date.now()) return hit;

  const record = type === 'staff' ? await Staff.findById(id) : await User.findById(id);
  const status = {
    exp: Date.now() + STATUS_TTL_MS,
    exists: !!record,
    // Staff use a strict truthy is_active; clients default-allow unless explicitly false.
    is_active: type === 'staff' ? !!(record && record.is_active)
                                : !!(record && record.is_active !== false),
    sessions_invalid_after: record ? record.sessions_invalid_after : null,
  };
  statusCache.set(key, status);
  return status;
}

// Called by logout / deactivation paths so the change is reflected immediately
// rather than after the TTL.
function invalidateAccountCache(type, id) {
  statusCache.delete(cacheKey(type, id));
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

  // Live suspension / session-termination check (staff AND clients). This is
  // what makes "Suspend Account", "Require MFA Authentication" and logout take
  // effect in real time: an existing token is rejected on its next request.
  // Backed by a short-lived status cache to avoid a DB round-trip per request.
  try {
    const status = await getAccountStatus(decoded.type, decoded.id);
    if (!status.exists || !status.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Your account has been suspended. Please contact the moderator.',
        deactivated: true,
      });
    }
    if (sessionTerminated(decoded, status.sessions_invalid_after)) {
      return res.status(401).json({
        success: false,
        message: 'Your session has ended. Please sign in again.',
        session_terminated: true,
      });
    }
  } catch (err) {
    return next(err);
  }

  // Device binding: a token whose `fp` claim doesn't match the HttpOnly
  // fingerprint cookie was replayed from somewhere other than the browser it was
  // issued to (captured token, log/Burp exfil). Reject it.
  //
  // Enforced only in production. In local development the app is often opened
  // from a different origin than the API (file://, 127.0.0.1, a Live-Server
  // port), so the SameSite=Strict cookie isn't delivered and every freshly
  // bound login would be force-logged-out on its next request. The secure
  // cookie flag is already gated on production for the same reason.
  if (process.env.NODE_ENV === 'production' && !fingerprintOk(req, decoded)) {
    return res.status(401).json({
      success: false,
      message: 'Your session is not valid on this device. Please sign in again.',
      session_terminated: true,
    });
  }

  next();
};

// Optional authentication — attaches req.user if a valid token is present,
// but does NOT reject requests that have no token (used for audit endpoints
// that should work whether the caller is logged in or not).
//
// SECURITY: a signature-valid token is NOT enough to be treated as an identity.
// We apply the SAME revocation/suspension checks as authenticate() — a
// logged-out (sessions_invalid_after) or suspended (is_active=false) account's
// token is downgraded to anonymous rather than being attributed to that user.
// On any failure we fall through as anonymous; we never reject here.
const optionalAuthenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_) {
    return next(); // invalid/expired token — treat as anonymous, do not reject
  }

  try {
    const status = await getAccountStatus(decoded.type, decoded.id);
    if (!status.exists || !status.is_active) return next();            // suspended/deleted
    if (sessionTerminated(decoded, status.sessions_invalid_after)) return next(); // logged out
  } catch (_) {
    return next(); // status unknown — never attribute identity on uncertainty
  }

  // Device binding (same as authenticate): a token replayed without its matching
  // fingerprint cookie is downgraded to anonymous rather than rejected here.
  // Enforced only in production (see authenticate for the dev rationale).
  if (process.env.NODE_ENV === 'production' && !fingerprintOk(req, decoded)) return next();

  req.user = { id: decoded.id, email: decoded.email, role: decoded.role, type: decoded.type };
  next();
};

module.exports = { authenticate, optionalAuthenticate, invalidateAccountCache };
