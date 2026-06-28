const crypto = require('crypto');

// ── JWT ↔ device fingerprint binding ─────────────────────────────────────────
// Closes the "captured token replay" gap: a JWT on its own is a bearer token —
// anyone holding it can use it until expiry. We bind each token to a secret that
// lives only in an HttpOnly cookie:
//
//   • At login we mint a high-entropy random value. The RAW value is returned to
//     the browser in an HttpOnly + SameSite=Strict cookie (JS — including XSS —
//     can't read it). Only the SHA-256 HASH of that value is embedded in the JWT
//     as the `fp` claim.
//   • On every authenticated request we re-hash the incoming cookie and compare
//     it to the token's `fp` claim.
//
// A token captured alone (Burp, logs, sessionStorage exfil) is now useless: the
// attacker doesn't have the matching cookie, so the hashes won't agree.
//
// NOTE: this relies on the frontend being served from the SAME ORIGIN as the API
// (it is — express.static in server.js), so the cookie rides along automatically
// with the default `same-origin` fetch credentials policy.

const COOKIE_NAME = 'bps_fp';

// Mint a fresh fingerprint: { raw } goes to the cookie, { hash } goes in the JWT.
function makeFingerprint() {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashOf(raw) };
}

function hashOf(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Set the HttpOnly fingerprint cookie alongside the JWT at login.
function setFingerprintCookie(req, res, raw) {
  res.cookie(COOKIE_NAME, raw, {
    httpOnly: true,            // unreadable from JS → XSS can't steal it
    sameSite: 'strict',        // never sent on cross-site requests
    // Secure only over HTTPS: a Secure cookie is silently dropped on plain
    // http://localhost during development. `trust proxy` is set in server.js so
    // req.secure reflects the X-Forwarded-Proto from a TLS-terminating proxy.
    secure: !!req.secure || process.env.NODE_ENV === 'production',
    path: '/',
    // No maxAge → session cookie, cleared on browser close, matching the
    // sessionStorage-based token lifetime on the client.
  });
}

function clearFingerprintCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/' });
}

// Read a single cookie from the raw header (avoids adding a cookie-parser dep).
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const idx = parts[i].indexOf('=');
    if (idx === -1) continue;
    if (parts[i].slice(0, idx).trim() === name) {
      return decodeURIComponent(parts[i].slice(idx + 1).trim());
    }
  }
  return null;
}

// Verify a decoded JWT against its bound fingerprint cookie.
//   • Token WITHOUT an `fp` claim → legacy token issued before binding existed;
//     allowed through so live sessions don't break on deploy. They become bound
//     the next time they log in.
//   • Token WITH an `fp` claim → the cookie MUST be present and hash-match.
// Returns true if the request may proceed, false if the binding fails.
function fingerprintOk(req, decoded) {
  if (!decoded || !decoded.fp) return true; // legacy / unbound token
  const raw = readCookie(req, COOKIE_NAME);
  if (!raw) return false;
  const a = Buffer.from(hashOf(raw));
  const b = Buffer.from(decoded.fp);
  if (a.length !== b.length) return false;   // timingSafeEqual requires equal length
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  COOKIE_NAME,
  makeFingerprint,
  setFingerprintCookie,
  clearFingerprintCookie,
  fingerprintOk,
};
