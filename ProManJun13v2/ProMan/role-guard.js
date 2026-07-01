/* ============================================================
   BPS Role Guard (SERVER-AUTHORITATIVE page access control)
   ------------------------------------------------------------
   Include this AFTER session.js on staff-only pages. It blocks
   direct-URL access to modules outside the signed-in role's
   scope.

   IMPORTANT: the allowed role is taken from the backend
   (/api/auth/verify-token, which derives it from the verified
   JWT) — NOT from sessionStorage, which the user can edit. The
   page is hidden until the server confirms the role, so a
   tampered `bps_user.role` can never reveal a privileged module
   (and the unauthorized user is redirected BEFORE any module
   MFA/OTP prompt can appear).

   Access matrix (page -> roles allowed):
     • Payment verification -> Supervising Psychometrician + Clinical Director
     • Psych reports        -> Supervising Psychometrician + QC + Psychologist + Clinical Director
     • Staff management     -> Clinical Director
     • Website management   -> Clinical Director
     • Admin dashboard      -> any staff role
   Pages NOT listed here are unrestricted (e.g. meetings.html is
   shared by staff hosts AND clients who join, profile, community).
   ============================================================ */
(function () {
  'use strict';

  var ALL_STAFF = [
    'psychometrician', 'supervising_psychometrician',
    'qc_psychometrician', 'psychologist', 'clinical_director',
  ];

  var PAGE_ACCESS = {
    'admin-dashboard.html':    ALL_STAFF,
    'case-dashboard.html':     ALL_STAFF,
    'payments-admin.html':     ['supervising_psychometrician', 'clinical_director'],
    // Report Module: Supervising Psychometrician (author), QC, Psychologist, Clinical
    // Director. Psychometricians are intentionally excluded — no report access at all.
    'psych-reports.html':      ['supervising_psychometrician', 'qc_psychometrician', 'psychologist', 'clinical_director'],
    'staff-management.html':   ['clinical_director'],
    'website-management.html': ['clinical_director'],
  };

  var page = (location.pathname.split('/').pop() || '').toLowerCase();
  var allowed = PAGE_ACCESS[page];
  if (!allowed) return; // page is not access-restricted

  var STAFF_LOGIN = 'staff-login.html';
  var ACCESS_DENIED = 'access-denied.html';
  var API_BASE = '/api/auth';

  // ── Hide the page until the server confirms the role ──
  // This prevents both a privileged-UI flash AND any module OTP/MFA prompt from
  // running before authorization is decided.
  var styleEl = document.createElement('style');
  styleEl.id = 'bps-roleguard-cloak';
  styleEl.textContent = 'html{visibility:hidden!important}';
  (document.head || document.documentElement).appendChild(styleEl);

  function reveal() {
    var el = document.getElementById('bps-roleguard-cloak');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function denyTo(dest) {
    try { sessionStorage.setItem('bps_access_denied', page); } catch (e) {}
    window.location.replace(dest);
  }

  function getToken() {
    try { return sessionStorage.getItem('bps_token'); } catch (e) { return null; }
  }

  // Resolve the trusted user via session.js if present, else call directly.
  function getTrustedUser() {
    if (window.BPSSession && typeof window.BPSSession.fetchTrustedUser === 'function') {
      return window.BPSSession.fetchTrustedUser();
    }
    var token = getToken();
    if (!token) return Promise.resolve(null);
    return fetch(API_BASE + '/verify-token', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (json) { return (json && json.data && json.data.user) ? json.data.user : null; })
      .catch(function () { return null; });
  }

  getTrustedUser().then(function (user) {
    // No valid session → send to staff login (these are all staff pages).
    if (!user) { denyTo(STAFF_LOGIN); return; }

    var role = user.role;
    if (!role || allowed.indexOf(role) === -1) {
      // Authenticated but not permitted for THIS module → access-denied page.
      denyTo(ACCESS_DENIED);
      return;
    }

    // Authorized — reveal the page.
    reveal();
  }).catch(function () {
    // Fail closed: if we cannot confirm the role, do not show the module.
    denyTo(STAFF_LOGIN);
  });

  // Safety net: never leave the page permanently cloaked if something throws
  // after a long delay (e.g. the API is unreachable). The redirect above is the
  // normal path; this only matters in pathological cases.
  setTimeout(function () {
    if (document.getElementById('bps-roleguard-cloak')) {
      // Still undecided after 8s — fail closed to login rather than reveal.
      denyTo(STAFF_LOGIN);
    }
  }, 8000);
})();
