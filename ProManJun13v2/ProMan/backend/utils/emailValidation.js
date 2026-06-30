const dns = require('dns').promises;

// ── Email validation helpers ─────────────────────────────────────────────────
// Syntactic checks accept things like "a@a.com" that are well-formed but point
// at a domain that can't actually receive mail. `domainCanReceiveMail` does a
// live DNS lookup to reject non-existent / non-mail domains (typos, throwaway
// junk). It canNOT prove a specific MAILBOX exists — only that the domain has a
// mail host. (True mailbox proof requires a confirmation email; that's exactly
// what the registration OTP already provides.)

const SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmailSyntax(email) {
  return SYNTAX_RE.test(String(email || '').trim());
}

/**
 * Resolve whether an email's domain can receive mail.
 *   • Prefer MX records.
 *   • Fall back to an A/AAAA record (RFC 5321 implicit MX).
 * Fail-OPEN on transient DNS errors (timeouts, server failures) so a network
 * blip never blocks a legitimate user; fail-CLOSED only when the domain
 * definitively does not exist or has no mail/address records.
 * @returns {Promise<boolean>}
 */
async function domainCanReceiveMail(email) {
  const str = String(email || '').trim().toLowerCase();
  const at = str.lastIndexOf('@');
  if (at === -1) return false;
  const domain = str.slice(at + 1);
  if (!domain || !domain.includes('.')) return false;

  // 1) MX records (the authoritative "this domain accepts mail" signal).
  try {
    const mx = await dns.resolveMx(domain);
    if (Array.isArray(mx) && mx.some((r) => r && r.exchange)) return true;
  } catch (err) {
    // Definitive negatives → reject. Anything else (ETIMEOUT, ESERVFAIL, …) is
    // transient → don't punish the user, fall through / allow.
    const definitive = err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'NXDOMAIN';
    if (!definitive) return true;
  }

  // 2) Implicit MX: a domain with an A/AAAA record may still accept mail.
  try { const a = await dns.resolve4(domain); if (a && a.length) return true; } catch (_) {}
  try { const a6 = await dns.resolve6(domain); if (a6 && a6.length) return true; } catch (_) {}

  return false;
}

module.exports = { SYNTAX_RE, isValidEmailSyntax, domainCanReceiveMail };
