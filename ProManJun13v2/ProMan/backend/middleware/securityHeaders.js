/**
 * Security headers + static-exposure guard.
 * ────────────────────────────────────────────────────────────────────────────
 * The frontend is served statically from the PROJECT ROOT (one level above
 * /backend). That root also contains the backend source, the .env secrets file,
 * SQL dumps, server logs, datasets and the knowledge-graph output. Without a
 * guard, all of those are downloadable (e.g. GET /backend/.env leaks JWT_SECRET,
 * DB_PASSWORD, SendGrid/Twilio/DocuSeal/reCAPTCHA keys).
 *
 * `blockSensitiveStatic` MUST be mounted BEFORE express.static so those paths
 * never reach the static file handler.
 *
 * `securityHeaders` adds the standard hardening headers — most importantly the
 * anti-clickjacking pair (X-Frame-Options + CSP frame-ancestors).
 */

// Any request whose normalized path matches one of these is refused (404 — we
// deliberately don't reveal that the path exists). Covers the server-side code,
// secrets, build/seed artifacts and anything that simply isn't a frontend asset.
const BLOCKED_PREFIXES = [
  '/backend',            // server source, /backend/.env, /backend/node_modules, uploads metadata, etc.
  '/node_modules',
  '/.git',
  '/postgresql',         // raw DB dumps
  '/datasets-updated',
  '/anonymized dataset',
  '/docs',
  '/graphify-out',       // full source knowledge graph
];

// Extensions / filenames that must never be served regardless of location.
const BLOCKED_EXT = /\.(env|sql|log|md|map|sh|bat|ps1|ini|conf|pem|key|crt|lock)$/i;
const BLOCKED_FILE = /(^|\/)(\.env(\..*)?|\.git|\.htaccess|package\.json|package-lock\.json|dockerfile|docker-compose\.ya?ml)$/i;

function blockSensitiveStatic(req, res, next) {
  // Only static GET/HEAD requests are relevant; the /api routes are matched
  // earlier in the stack and never reach here.
  let pathname;
  try {
    pathname = decodeURIComponent((req.path || '').toLowerCase());
  } catch (_) {
    return res.status(400).json({ success: false, message: 'Bad request' });
  }

  // Normalize backslashes (Windows) and collapse any traversal attempts.
  pathname = pathname.replace(/\\/g, '/');

  // Reject path traversal outright.
  if (pathname.includes('..')) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }

  // Hidden dotfiles anywhere in the path (/.env, /foo/.git/…).
  if (pathname.split('/').some((seg) => seg.startsWith('.') && seg.length > 1)) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }

  if (BLOCKED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  if (BLOCKED_EXT.test(pathname) || BLOCKED_FILE.test(pathname)) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }

  next();
}

// Content-Security-Policy. Sources are limited to what the app actually loads
// (DocuSeal, cdnjs, unpkg, Google reCAPTCHA/Fonts, OpenStreetMap). The crucial
// directive for this task is `frame-ancestors 'none'` — together with
// X-Frame-Options it makes the app impossible to embed in a frame (clickjacking
// protection). Inline scripts/styles are allowed because the pages rely on them
// heavily; tightening that further would require a page-by-page nonce rollout.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.docuseal.com https://cdnjs.cloudflare.com https://unpkg.com https://www.google.com https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://unpkg.com",
  "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' http://localhost:5000 ws://localhost:5000 https://cdn.docuseal.com https://api.docuseal.com https://www.google.com https://nominatim.openstreetmap.org",
  "frame-src 'self' https://cdn.docuseal.com https://docuseal.com https://www.google.com https://www.openstreetmap.org",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join('; ');

function securityHeaders(_req, res, next) {
  // ── Anti-clickjacking ──
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');

  // ── Other standard hardening headers ──
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // disable legacy auditor (CSP supersedes it)
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(self), payment=(), usb=(), fullscreen=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // HSTS is only honored over HTTPS; harmless on http and correct once TLS-terminated.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  next();
}

module.exports = { securityHeaders, blockSensitiveStatic };
