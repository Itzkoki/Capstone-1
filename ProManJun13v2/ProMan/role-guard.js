/* ============================================================
   BPS Role Guard (client-side RBAC enforcement)
   ------------------------------------------------------------
   Include this AFTER session.js on staff-only pages. It blocks
   direct-URL access to modules outside the signed-in role's
   scope by redirecting (hide + redirect). The navbar / dashboard
   already hide out-of-scope links; this stops someone from
   typing the URL directly.

   Access matrix (page -> roles allowed):
     • Intake submissions   -> Psychometrician + Clinical Director
     • Payment verification -> Supervising Psychometrician + Clinical Director
     • Psych reports        -> Psychologist + QC Psychometrician + Clinical Director
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
    'payments-admin.html':     ['supervising_psychometrician', 'clinical_director'],
    // Report Module: Supervising Psychometrician (author), QC, Psychologist, Clinical
    // Director. Psychometricians are intentionally excluded — no report access at all.
    'psych-reports.html':      ['supervising_psychometrician', 'qc_psychometrician', 'psychologist', 'clinical_director'],
    'staff-management.html':   ['clinical_director'],
    'website-management.html': ['clinical_director'],
  };

  var user = {};
  try { user = JSON.parse(sessionStorage.getItem('bps_user') || '{}') || {}; } catch (e) {}
  var role = user && user.role;

  var page = (location.pathname.split('/').pop() || '').toLowerCase();
  var allowed = PAGE_ACCESS[page];
  if (!allowed) return; // page is not access-restricted

  if (!role || allowed.indexOf(role) === -1) {
    // Remember what was denied so the destination page can surface a message.
    try { sessionStorage.setItem('bps_access_denied', page); } catch (e) {}
    // Staff land back on their dashboard; clients (or logged-out) go to landing.
    var dest = (role && role !== 'client') ? 'admin-dashboard.html' : 'landingpage.html';
    if (page === dest) dest = 'landingpage.html'; // avoid a redirect loop
    window.location.replace(dest);
  }
})();
