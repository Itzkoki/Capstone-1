/* ============================================================
   BPS Shared Navbar builder
   ------------------------------------------------------------
   Renders a consistent, role-aware navbar with hover dropdowns
   (desktop) and an accordion drawer (tablet / mobile) on every
   page that contains a `.navbar` element.

   Roles:
     • logged-out / client  -> public "USER" menu
     • any staff role        -> "ADMIN & CLINICAL STAFF" menu
       (Website Management item is clinic-admin / clinical_director only)

   The brand link, notification bell and profile / Get-Started
   controls already present on each page are left untouched; this
   script only owns the link list, the dropdowns and the hamburger.
   ============================================================ */
(function () {
  'use strict';

  // ---------- auth + role ----------
  var loggedIn = false, user = {};
  try { loggedIn = sessionStorage.getItem('bps_logged_in') === 'true'; } catch (e) {}
  try { user = JSON.parse(sessionStorage.getItem('bps_user') || '{}') || {}; } catch (e) {}
  // Derive the role for the FIRST PAINT from the JWT, not from bps_user.role.
  // The token is signed by the server, so a client can't forge a staff role into
  // it — editing bps_user.role in devtools therefore has no effect on the menu.
  // (bps_user.role is only a display cache; reconcileRole() below snaps it back
  // to the server's truth on every load so a tampered value never persists.)
  var role = decodeJwtRole() || (user && user.role ? user.role : null);
  var isStaff = loggedIn && role && role !== 'client';
  var isClinicAdmin = role === 'clinical_director';

  if (loggedIn) { document.body.classList.add('logged-in'); }

  // current page filename, e.g. "community.html"
  var page = (location.pathname.split('/').pop() || 'landingpage.html').toLowerCase() || 'landingpage.html';

  // landing-page anchors are absolute so they work from any page
  var LP = 'landingpage.html';

  // ---------- icon set (Material-style 24x24 path data) ----------
  var ICONS = {
    home:      'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    info:      'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
    vision:    'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zm0 12a4.5 4.5 0 110-9 4.5 4.5 0 010 9zm0-7a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
    team:      'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    star:      'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    services:  'M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z',
    video:     'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z',
    clipboard: 'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z',
    ticket:    'M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2z',
    support:   'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
    question:  'M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z',
    document:  'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    chat:      'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z',
    mail:      'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
    dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
    payment:   'M20 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z',
    globe:     'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95a15.65 15.65 0 00-1.38-3.56A8.03 8.03 0 0118.92 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.987 7.987 0 015.08 16zm2.95-8H5.08a7.987 7.987 0 014.33-3.56A15.65 15.65 0 008.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 01-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z',
    archive:   'M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z',
    contact:   'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z'
  };
  function icSvg(name, cls) {
    var d = ICONS[name];
    if (!d) return '';
    return '<svg class="' + (cls || 'nav-ic') + '" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  // ---------- menu models ----------
  function publicMenu() {
    return [
      { label: 'Home', href: LP, match: ['landingpage.html', ''] },
      { label: 'About Us', href: LP + '#mission-vision', drop: [
        { label: 'Vision & Mission', href: LP + '#mission-vision', ic: 'vision' },
        { label: 'Meet the Team',    href: LP + '#team', ic: 'team' },
        { label: 'Facilities',       href: LP + '#about', ic: 'star' }
      ]},
      { label: 'Services', href: LP + '#services', match: ['intakeform.html', 'meetings.html', 'requests.html'], drop: [
        { label: 'Teleconference',       href: 'meetings.html', ic: 'video' },
        { label: 'Intake Form',          href: 'intakeform.html', ic: 'clipboard' },
        { label: 'Requests & Concerns',  href: 'requests.html', ic: 'ticket' },
      ]},
      { label: 'Community', href: 'community.html', match: ['community.html'], drop: [
        { label: 'FAQs',        href: 'community.html?tab=faqs', ic: 'question' },
        { label: 'Articles',    href: 'community.html?tab=articles', ic: 'document' },
        { label: 'Discussions', href: 'community.html?tab=discussion', ic: 'chat' }
      ]},
      { label: 'Contact', href: 'contact.html' }
    ];
  }

  // Per-role Dashboard menu. Each clinical role sees ONLY the modules it owns;
  // every staff role additionally gets Teleconference (host/create a session).
  // The Clinical Director sees everything.
  function dashItemsForRole(r) {
    var TELE    = { label: 'Teleconference',        href: 'meetings.html',                    ic: 'video' };
    var PAY     = { label: 'Payment Verification',  href: 'payments-admin.html',              ic: 'payment' };
    var CASES   = { label: 'Case Management',       href: 'case-dashboard.html',              ic: 'clipboard' };
    var REPORTS = { label: 'Reports',               href: 'psych-reports.html',               ic: 'document' };

    switch (r) {
      case 'psychometrician':
        // Psychometricians have NO access to the Report Module.
        return [CASES, TELE];
      case 'supervising_psychometrician':
        return [CASES, REPORTS, PAY, TELE];
      case 'qc_psychometrician':
        return [CASES, REPORTS, TELE];
      case 'psychologist':
        return [CASES, REPORTS, TELE];
      case 'clinical_director':
        return [
          CASES, REPORTS,
          { label: 'Staff Management', href: 'staff-management.html', ic: 'team' },
          PAY, TELE,
          { label: 'Website Management', href: 'website-management.html', ic: 'globe' }
        ];
      default:
        return [CASES, REPORTS, TELE];
    }
  }

  function staffMenu() {
    var dash = dashItemsForRole(role);

    return [
      { label: 'Home', href: LP, match: ['landingpage.html', ''] },
      { label: 'About Us', href: LP + '#mission-vision', drop: [
        { label: 'Vision & Mission', href: LP + '#mission-vision', ic: 'vision' },
        { label: 'Meet the Team',    href: LP + '#team', ic: 'team' },
        { label: 'Facilities',       href: LP + '#about', ic: 'star' }
      ]},
      { label: 'Dashboard', href: 'admin-dashboard.html',
        match: ['admin-dashboard.html', 'psych-reports.html', 'staff-management.html',
                'payments-admin.html', 'meetings.html', 'website-management.html', 'case-dashboard.html'],
        drop: dash },
      { label: 'Community', href: 'community.html',
        match: ['community.html', 'moderation.html'], drop: [
        { label: 'FAQs',                 href: 'community.html?tab=faqs', ic: 'question' },
        { label: 'Articles',             href: 'community.html?tab=articles', ic: 'document' },
        { label: 'Discussions',          href: 'community.html?tab=discussion', ic: 'chat' },
        { label: 'Moderation Dashboard', href: 'moderation.html', ic: 'dashboard' }
      ]},
      { label: 'Contact', href: 'contact.html' }
    ];
  }

  var menu = isStaff ? staffMenu() : publicMenu();

  // ---------- helpers ----------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  var CARET = '<svg class="nav-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>';
  var SUBCARET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>';

  function isActiveTop(item) {
    var m = item.match || [];
    for (var i = 0; i < m.length; i++) { if (m[i] === page) return true; }
    return false;
  }
  // file part of a dropdown href, ignoring query/hash
  function fileOf(href) { return href.split('#')[0].split('?')[0].toLowerCase(); }

  function buildItem(item) {
    var li = document.createElement('li');
    li.className = 'nav-item' + (item.drop ? ' has-dropdown' : '');

    var activeTop = isActiveTop(item);
    var a = document.createElement('a');
    a.href = item.href;
    a.innerHTML = icSvg(item.ic) + esc(item.label) + (item.drop ? CARET : '');
    if (activeTop) a.classList.add('active');
    if (item.drop) { a.setAttribute('aria-haspopup', 'true'); a.setAttribute('aria-expanded', 'false'); }
    li.appendChild(a);

    if (item.drop) {
      // mobile-only expand toggle
      var sub = document.createElement('button');
      sub.type = 'button';
      sub.className = 'nav-subtoggle';
      sub.setAttribute('aria-label', 'Toggle ' + item.label + ' menu');
      sub.innerHTML = SUBCARET;
      sub.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        li.classList.toggle('open');
        var exp = li.classList.contains('open');
        a.setAttribute('aria-expanded', exp ? 'true' : 'false');
      });
      li.appendChild(sub);

      var ul = document.createElement('ul');
      ul.className = 'nav-dropdown';
      ul.setAttribute('role', 'menu');
      item.drop.forEach(function (d) {
        var dli = document.createElement('li');
        var da = document.createElement('a');
        da.href = d.href; da.innerHTML = icSvg(d.ic) + esc(d.label); da.setAttribute('role', 'menuitem');
        // highlight the exact sub-item that matches the current page (+tab)
        if (fileOf(d.href) === page) {
          var tab = (d.href.split('?')[1] || '');
          var curTab = (location.search || '').replace(/^\?/, '');
          if (!tab || tab === curTab) da.classList.add('active');
        }
        dli.appendChild(da); ul.appendChild(dli);
      });
      li.appendChild(ul);
    }
    return li;
  }

  // ---------- render ----------
  function render() {
    var nav = document.querySelector('.navbar');
    if (!nav) return;

    var right = nav.querySelector('.navbar__right');
    var list = nav.querySelector('.navbar__links');

    // ensure a link list exists inside the right cluster
    if (!list) {
      list = document.createElement('ul');
      list.className = 'navbar__links';
      if (right) right.insertBefore(list, right.firstChild);
      else nav.appendChild(list);
    }
    list.id = 'nav-links';
    list.innerHTML = '';
    menu.forEach(function (item) { list.appendChild(buildItem(item)); });

    // hamburger toggle (insert once, at the end of the right cluster)
    if (!nav.querySelector('.navbar__toggle')) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'navbar__toggle';
      btn.setAttribute('aria-label', 'Menu');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '<span class="bar"></span>';
      btn.addEventListener('click', function () {
        var open = document.body.classList.toggle('nav-open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      if (right) right.appendChild(btn);
      else nav.appendChild(btn);
    }

    // close the drawer after following an in-page link / navigating
    list.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        document.body.classList.remove('nav-open');
        var t = nav.querySelector('.navbar__toggle');
        if (t) t.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // ---------- scroll shadow + outside-click close ----------
  function wire() {
    var nav = document.querySelector('.navbar');
    if (!nav) return;
    if (!nav.dataset.scrollWired) {
      nav.dataset.scrollWired = '1';
      window.addEventListener('scroll', function () {
        nav.classList.toggle('scrolled', window.scrollY > 20);
      }, { passive: true });
    }
    document.addEventListener('click', function (e) {
      if (document.body.classList.contains('nav-open') && !e.target.closest('.navbar')) {
        document.body.classList.remove('nav-open');
        var t = nav.querySelector('.navbar__toggle');
        if (t) t.setAttribute('aria-expanded', 'false');
      }
    });
    // collapse drawer when resizing back to desktop
    window.addEventListener('resize', function () {
      if (window.innerWidth > 860) document.body.classList.remove('nav-open');
    });
  }

  // ---------- notification unread badge (real-time) ----------
  var NOTIF_API = '/api/notifications';
  function getToken() { try { return sessionStorage.getItem('bps_token'); } catch (e) { return null; } }
  // Guarantee a badge span exists inside the bell on every page that has one.
  function ensureBadgeEl() {
    var el = document.getElementById('notif-badge');
    if (el) return el;
    var bell = document.querySelector('.navbar__notif');
    if (!bell) return null;
    el = document.createElement('span');
    el.className = 'navbar__notif-badge';
    el.id = 'notif-badge';
    bell.appendChild(el);
    return el;
  }
  function setNotifBadge(count) {
    var el = ensureBadgeEl();
    if (!el) return;
    count = parseInt(count, 10) || 0;
    if (count > 0) {
      el.textContent = count > 99 ? '99+' : String(count);
      el.classList.add('show');
      el.removeAttribute('style');            // drop any inline display:none
      el.setAttribute('aria-label', count + ' unread notifications');
    } else {
      el.textContent = '';
      el.classList.remove('show');            // hidden when zero
      el.setAttribute('aria-label', 'No unread notifications');
    }
  }
  function refreshNotifBadge() {
    if (!loggedIn) { setNotifBadge(0); return; }
    var tok = getToken();
    if (!tok) { setNotifBadge(0); return; }
    fetch(NOTIF_API + '/unread-count', { headers: { 'Authorization': 'Bearer ' + tok } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (json) {
        if (!json) return;
        var count = (json.data && typeof json.data.count !== 'undefined') ? json.data.count : 0;
        setNotifBadge(count);
      })
      .catch(function () { /* silent */ });
  }
  // Exposed so the notifications page can push immediate updates after
  // mark-as-read / delete without waiting for the next poll.
  window.BPSNotifBadge = { set: setNotifBadge, refresh: refreshNotifBadge };

  // ---------- server-authoritative role reconciliation ----------
  // The initial menu above is built from the sessionStorage role for a fast
  // first paint, but sessionStorage is client-controlled: a client can flip
  // bps_user.role to a staff role and would otherwise see the full staff menu
  // (Case Management, Reports, Staff Management, …). That is a frontend
  // privilege-escalation *display* bug. Here we ask the server for the role it
  // derives from the verified JWT and, if it disagrees, rebuild the navbar from
  // the trusted value — so a tampered role can never reveal the staff menu, and
  // an expired/revoked token collapses back to the public menu.
  var VERIFY_API = '/api/auth/verify-token';

  // Read the role straight out of the JWT payload. The token is server-signed,
  // so this value can't be forged by editing sessionStorage — a client can't
  // mint a staff role into it without the server's secret. (We don't verify the
  // signature here; that's the backend's job. We only use it for display, and
  // reconcileRole() confirms it against the server anyway.)
  function decodeJwtRole() {
    var tok = getToken();
    if (!tok) return null;
    try {
      var payload = tok.split('.')[1];
      if (!payload) return null;
      payload = payload.replace(/-/g, '+').replace(/_/g, '/');
      var json = JSON.parse(decodeURIComponent(escape(atob(payload))));
      return json && json.role ? json.role : null;
    } catch (e) { return null; }
  }

  function fetchTrustedRole(cb) {
    var tok = getToken();
    if (!tok) { cb(null); return; }                 // no token => not staff
    fetch(VERIFY_API, { headers: { 'Authorization': 'Bearer ' + tok } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { cb(j && j.data && j.data.user ? j.data.user.role : null); })
      .catch(function () { cb(undefined); });         // network error => unknown
  }

  function reconcileRole() {
    fetchTrustedRole(function (trustedRole) {
      if (trustedRole === undefined) return;          // unknown — keep current render

      // ALWAYS overwrite the stored display role with the server's truth, even
      // when the menu doesn't change. This is what makes a devtools edit to
      // bps_user.role NOT persist: on the next load it's snapped back to the
      // real role. Authorization never trusts this value regardless.
      try {
        var u = JSON.parse(sessionStorage.getItem('bps_user') || '{}') || {};
        var want = trustedRole || 'client';
        if (u.role !== want) {
          u.role = want;
          sessionStorage.setItem('bps_user', JSON.stringify(u));
        }
      } catch (e) {}

      var trustedIsStaff = !!(trustedRole && trustedRole !== 'client');
      var changed = trustedIsStaff !== isStaff ||
                    (trustedIsStaff && trustedRole !== role);
      if (!changed) return;

      role = trustedRole;
      isStaff = trustedIsStaff;
      isClinicAdmin = role === 'clinical_director';
      menu = isStaff ? staffMenu() : publicMenu();
      render();
    });
  }

  function init() { render(); wire(); refreshNotifBadge(); reconcileRole(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Real-time unread badge: poll periodically and refresh on tab focus.
  // (Initial fetch happens inside init() once the DOM/bell is ready.)
  setInterval(refreshNotifBadge, 20000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshNotifBadge();
  });
})();
