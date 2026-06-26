/**
 * BPS Session Management
 * ──────────────────────────────────────────────────────
 * Include this script at the TOP of every protected page
 * (before other scripts) to enforce authentication.
 *
 * Uses sessionStorage so the session is automatically
 * cleared when the browser or tab is closed.
 *
 * Usage:
 *   <script src="session.js"></script>
 *
 * Provides a global `BPSSession` object with helpers:
 *   BPSSession.getToken()   → JWT string or null
 *   BPSSession.getUser()    → parsed user object or {}
 *   BPSSession.isLoggedIn() → boolean
 *   BPSSession.logout()     → clears session & redirects
 */
(function () {
  'use strict';

  const API_BASE = 'http://localhost:5000/api/auth';
  const LOGIN_PAGE = 'login.html';
  const STAFF_LOGIN_PAGE = 'staff-login.html';
  const CLIENT_HOME = 'landingpage.html';
  const STAFF_HOME = 'admin-dashboard.html';

  // How often to re-validate the session with the server. This is what makes a
  // staff deactivation log the user out automatically even if they are just
  // sitting on a page without triggering any other API call.
  const VALIDATE_INTERVAL_MS = 300000;

  // ── Storage helpers (sessionStorage — cleared on browser close) ──
  function getToken() {
    return sessionStorage.getItem('bps_token');
  }

  function getUser() {
    try {
      return JSON.parse(sessionStorage.getItem('bps_user') || '{}');
    } catch {
      return {};
    }
  }

  function isLoggedIn() {
    return !!getToken() && sessionStorage.getItem('bps_logged_in') === 'true';
  }

  // CAPTCHA / OTP clearances this app may have stored during the session.
  // Kept in sync with captcha.js. Cleared on logout so the next user must
  // re-verify from scratch — even on pages where captcha.js isn't loaded.
  const CAPTCHA_SESSION_KEYS = [
    'bps_community_cap',
    'bps_meetings_cap',
    'bps_psych_cap',
    'bps_staffmgmt_cap',
    'bps_payments_cap',
    'bps_requests_cap',
    'bps_case_cap',
    'bps_tc_otp',
  ];

  function clearSession() {
    sessionStorage.removeItem('bps_token');
    sessionStorage.removeItem('bps_user');
    sessionStorage.removeItem('bps_logged_in');
    // Reset every CAPTCHA / Teleconference-OTP clearance on logout.
    if (window.BPSCaptcha && typeof window.BPSCaptcha.clearAllSessions === 'function') {
      try { window.BPSCaptcha.clearAllSessions(); } catch (_) {}
    }
    CAPTCHA_SESSION_KEYS.forEach((k) => sessionStorage.removeItem(k));
    // Module-access OTP flags are dynamic (bps_module_otp_<module>) and the
    // per-session teleconference OTP keys (bps_tc_otp_<id>) too — sweep both by
    // prefix so the next session must request a brand-new OTP, even when this
    // logout happens on a page where captcha.js was never loaded.
    Object.keys(sessionStorage)
      .filter((k) => k.indexOf('bps_module_otp_') === 0 || k.indexOf('bps_tc_otp') === 0)
      .forEach((k) => sessionStorage.removeItem(k));
  }

  // Staff go back to the staff login page; clients to the client login page.
  function loginPageForUser() {
    const user = getUser();
    return (user.role && user.role !== 'client') ? STAFF_LOGIN_PAGE : LOGIN_PAGE;
  }

  function logout() {
    const dest = loginPageForUser();
    clearSession();
    // Broadcast logout to other tabs via localStorage event
    localStorage.setItem('bps_logout', Date.now().toString());
    // Use replace so the back button can't return to the protected page
    window.location.replace(dest);
  }

  // ── Determine correct home page based on role ──────
  function getHomePage() {
    const user = getUser();
    return (user.role && user.role !== 'client') ? STAFF_HOME : CLIENT_HOME;
  }

  // ── Guard: redirect unauthenticated users ──────────
  function guardProtectedPage() {
    if (!isLoggedIn()) {
      clearSession();
      window.location.replace(LOGIN_PAGE);
      return false;
    }

    // Remove login page from history stack so back-button won't go there
    history.replaceState(null, '', window.location.href);
    return true;
  }

  // ── Async: validate token with the server ──────────
  // Returns true if the session is still valid, false if it was force-logged-out.
  async function validateTokenAsync() {
    const token = getToken();
    if (!token) return true;

    try {
      const res = await fetch(`${API_BASE}/verify-token`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!res.ok) {
        // Token is invalid/expired, or the staff account was deactivated server
        // side — force logout to the appropriate login page.
        const dest = loginPageForUser();
        clearSession();
        localStorage.setItem('bps_logout', Date.now().toString());
        window.location.replace(dest);
        return false;
      }
      return true;
    } catch {
      // Network error — keep the session alive (offline tolerance).
      // The next API call will fail with 401 anyway.
      return true;
    }
  }

  // ── Execute guard immediately ──────────────────────
  if (guardProtectedPage()) {
    // Fire-and-forget server-side validation on load…
    validateTokenAsync();
    // …then keep re-validating so a deactivated staff member is logged out
    // automatically while idle on a page.
    setInterval(validateTokenAsync, VALIDATE_INTERVAL_MS);
  }

  // ── Cross-tab logout synchronization ───────────────
  // When another tab logs out, it writes to localStorage.
  // The 'storage' event fires in all OTHER tabs of the same origin.
  window.addEventListener('storage', (event) => {
    if (event.key === 'bps_logout' && event.newValue) {
      clearSession();
      window.location.replace(LOGIN_PAGE);
    }
  });

  // ── Expose global BPSSession ───────────────────────
  window.BPSSession = {
    getToken,
    getUser,
    isLoggedIn,
    logout,
    getHomePage,
    clearSession,
  };
})();
