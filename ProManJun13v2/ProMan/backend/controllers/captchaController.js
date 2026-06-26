const https = require('https');
const jwt   = require('jsonwebtoken');
const db    = require('../config/db');
const securityEvents = require('../services/securityEvents');

const RECAPTCHA_SECRET    = process.env.RECAPTCHA_SECRET_KEY || '';
const MIN_SCORE           = parseFloat(process.env.RECAPTCHA_MIN_SCORE || '0.5');
// Set RECAPTCHA_SKIP_VERIFY=true in .env for local development without real keys
const SKIP_VERIFY         = process.env.RECAPTCHA_SKIP_VERIFY === 'true';

// reCAPTCHA v2 ("I'm not a robot" checkbox) — used as a fallback challenge when
// a v3 score is suspicious (below MIN_SCORE). v2 has no score; passing the
// checkbox is treated as human.
const RECAPTCHA_V2_SECRET   = process.env.RECAPTCHA_V2_SECRET_KEY || '';
const RECAPTCHA_V2_SITE_KEY = process.env.RECAPTCHA_V2_SITE_KEY || '';

// ── POST /api/captcha/verify ──────────────────────────────────────────
// Default (version 'v3'): score the token; a passing score issues a clearance,
// a suspicious score asks the client to fall back to the v2 checkbox challenge.
// version 'v2': verify the checkbox response against the v2 secret.
const verifyCaptcha = async (req, res, next) => {
  try {
    const { token, action } = req.body;
    const version = req.body.version === 'v2' ? 'v2' : 'v3';

    if (!token) {
      return res.status(400).json({ success: false, message: 'CAPTCHA token is required.' });
    }

    // Development bypass when no real keys are configured
    if (SKIP_VERIFY || !RECAPTCHA_SECRET) {
      await _logEvent(req, action, true, 1.0, 'skip_verify');
      const clearance_token = _issueClearance(action, req.ip);
      return res.status(200).json({ success: true, score: 1.0, clearance_token, message: 'CAPTCHA verified (dev mode).' });
    }

    // ── v2 fallback path: verify the checkbox response ────────────────
    if (version === 'v2') {
      if (!RECAPTCHA_V2_SECRET) {
        await _logEvent(req, action, false, 0, 'v2_not_configured');
        return res.status(200).json({ success: false, message: 'Security check unavailable. Please try again later.' });
      }
      const v2Res = await _callGoogle(token, req.ip || '', RECAPTCHA_V2_SECRET);
      if (!v2Res.success) {
        await _logEvent(req, action, false, 0, v2Res['error-codes']?.join(',') || 'v2_rejected', 'v2');
        return res.status(200).json({ success: false, message: 'Verification failed. Please try the checkbox again.' });
      }
      await _logEvent(req, action, true, null, 'v2_passed', 'v2');
      const clearance_token = _issueClearance(action, req.ip);
      return res.status(200).json({ success: true, version: 'v2', clearance_token });
    }

    // ── v3 path: score the token ──────────────────────────────────────
    const googleRes = await _callGoogle(token, req.ip || '', RECAPTCHA_SECRET);

    if (!googleRes.success) {
      await _logEvent(req, action, false, 0, googleRes['error-codes']?.join(',') || 'google_rejected');
      // A hard token failure can still offer the v2 challenge so a legitimate
      // user with a flaky token isn't permanently blocked.
      if (RECAPTCHA_V2_SECRET && RECAPTCHA_V2_SITE_KEY) {
        return res.status(200).json({
          success: false,
          challenge_required: true,
          version: 'v2',
          site_key: RECAPTCHA_V2_SITE_KEY,
          message: 'Please complete the additional verification below.',
        });
      }
      return res.status(200).json({ success: false, message: 'Security check failed. Please try again.' });
    }

    const score = googleRes.score ?? 0;

    // Print the v3 score to the terminal after every answered CAPTCHA.
    const outcome = score < MIN_SCORE ? 'SUSPICIOUS → v2 challenge' : 'PASS';
    console.log(`🔐 reCAPTCHA v3 score: ${score.toFixed(2)} (threshold ${MIN_SCORE}) · action="${action || 'n/a'}" · ${outcome}`);

    if (score < MIN_SCORE) {
      await _logEvent(req, action, false, score, 'low_score');
      // Suspicious score → escalate to the v2 checkbox instead of a flat reject.
      if (RECAPTCHA_V2_SECRET && RECAPTCHA_V2_SITE_KEY) {
        return res.status(200).json({
          success: false,
          challenge_required: true,
          version: 'v2',
          site_key: RECAPTCHA_V2_SITE_KEY,
          score,
          message: 'Please complete the additional verification below.',
        });
      }
      return res.status(200).json({
        success: false,
        message: 'Our automated system flagged this request. Please try again.',
      });
    }

    await _logEvent(req, action, true, score, null);
    const clearance_token = _issueClearance(action, req.ip);
    return res.status(200).json({ success: true, score, clearance_token });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/captcha/audit ───────────────────────────────────────────
// Front-end audit events (captcha_displayed, etc.)
const auditEvent = async (req, res, next) => {
  try {
    const { event, action, score, reason, context } = req.body;
    const userId = req.user?.id || null;

    await db.query(
      `INSERT INTO security_audit_log (user_id, event_type, action, score, reason, context, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT DO NOTHING`,
      [userId, event || 'unknown', action || null, score || null, reason || null, context || null, req.ip || null]
    ).catch(() => {}); // non-fatal — table may not exist in all environments

    return res.status(200).json({ success: true });
  } catch (_) {
    return res.status(200).json({ success: true }); // always 200; audit is best-effort
  }
};

// ── Helpers ───────────────────────────────────────────────────────────
// Signs a 5-minute clearance token so callers can use it in subsequent
// requests (e.g. login) without re-verifying with Google.
function _issueClearance(action, ip) {
  try {
    return jwt.sign(
      { captcha_action: action, ip: ip || '' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
  } catch (_) {
    return null;
  }
}

// Validates a clearance token. Returns the payload or null.
function validateClearance(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (_) {
    return null;
  }
}

function _callGoogle(token, remoteIp, secret) {
  return new Promise((resolve, reject) => {
    const params = `secret=${encodeURIComponent(secret || RECAPTCHA_SECRET)}&response=${encodeURIComponent(token)}&remoteip=${encodeURIComponent(remoteIp)}`;
    const options = {
      hostname: 'www.google.com',
      path: '/recaptcha/api/siteverify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params),
      },
    };

    const request = https.request(options, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('Invalid Google response')); }
      });
    });

    request.on('error', reject);
    request.write(params);
    request.end();
  });
}

async function _logEvent(req, action, success, score, failReason, version = 'v3') {
  const userId = req.user?.id || null;
  try {
    await db.query(
      `INSERT INTO security_audit_log (user_id, event_type, action, score, reason, context, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [userId, success ? 'captcha_success' : 'captcha_failure', action || null, score, failReason, `recaptcha_${version}`, req.ip || null]
    );
  } catch (_) {
    // Table created by migration; silently skip if not ready
  }
}

// ── POST /api/captcha/psych-access ─────────────────────────────────
// Staff-only. Validates the captcha clearance token issued by /captcha/verify
// and records the Psych Reports access decision in the audit log.
const psychAccess = async (req, res, next) => {
  try {
    const userId = req.user?.id || null;
    const role   = req.user?.role || '';

    // Only staff roles may access Psych Reports
    if (!userId || role === 'client') {
      // A client reaching the staff-only report surface is a HIGH-severity
      // unauthorized-access event → opens an incident + alerts the CD.
      await securityEvents.record({
        module: 'report_storage', eventType: 'unauthorized_report_access',
        userId, ip: req.ip, details: `Non-staff (role="${role || 'none'}") attempted Psych Reports access.`,
      });
      return res.status(403).json({ success: false, message: 'Access denied. Staff only.' });
    }

    const { captcha_clearance } = req.body;
    const payload = captcha_clearance ? validateClearance(captcha_clearance) : null;

    // Allow bypass in dev mode (same as login endpoint)
    const devBypass = process.env.RECAPTCHA_SKIP_VERIFY === 'true' || !process.env.RECAPTCHA_SECRET_KEY;

    if (!devBypass && !payload) {
      await _logPsychEvent(req, userId, 'psych_reports_access_denied', 'invalid_clearance');
      return res.status(428).json({ success: false, message: 'CAPTCHA verification required.' });
    }

    await _logPsychEvent(req, userId, 'psych_reports_access_granted', null);
    return res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

async function _logPsychEvent(req, userId, eventType, reason) {
  try {
    await db.query(
      `INSERT INTO security_audit_log (user_id, event_type, action, reason, context, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [userId, eventType, 'psych_reports', reason || null, 'psych_reports', req.ip || null]
    );
  } catch (_) {}
}

module.exports = { verifyCaptcha, auditEvent, validateClearance, psychAccess };
