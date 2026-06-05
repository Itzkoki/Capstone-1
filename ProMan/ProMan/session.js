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
  const CLIENT_HOME = 'landingpage.html';
  const STAFF_HOME = 'admin-dashboard.html';

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

  function clearSession() {
    sessionStorage.removeItem('bps_token');
    sessionStorage.removeItem('bps_user');
    sessionStorage.removeItem('bps_logged_in');
  }

  function logout() {
    clearSession();
    // Broadcast logout to other tabs via localStorage event
    localStorage.setItem('bps_logout', Date.now().toString());
    // Use replace so the back button can't return to the protected page
    window.location.replace(LOGIN_PAGE);
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
  async function validateTokenAsync() {
    const token = getToken();
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE}/verify-token`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!res.ok) {
        // Token is invalid or expired — force logout
        clearSession();
        window.location.replace(LOGIN_PAGE);
      }
    } catch {
      // Network error — keep the session alive (offline tolerance)
      // The next API call will fail with 401 anyway
    }
  }

  // ── Execute guard immediately ──────────────────────
  if (guardProtectedPage()) {
    // Fire-and-forget server-side validation
    validateTokenAsync();
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
