/* ============================================================
   icons.js — shared inline-SVG icon set for Barcarse PS.

   Replaces ad-hoc emojis (📅 📄 ✓ ✗ 🔒 …) with one consistent,
   professional icon set used across every staff/admin page.

   Usage (inside template strings that build buttons, etc.):
     `<button class="action-btn primary">${ICON.calendar} Confirm</button>`

   Icons are 24×24 stroke icons that inherit the surrounding text
   colour (stroke:currentColor), so they automatically match the
   button/label they sit in. A tiny <style> block (injected once on
   load) handles sizing + vertical alignment, so no per-page CSS
   change is required — any page that loads this file gets it.
   ============================================================ */
(function (global) {
  'use strict';

  // wrap raw <path>/<line>… markup in a sized, currentColor <svg class="ico">
  function svg(inner) {
    return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>';
  }

  var ICON = {
    check:       svg('<path d="M20 6 9 17l-5-5"/>'),
    checkCircle: svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m22 4-10 10.01-3-3"/>'),
    x:           svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    calendar:    svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
    document:    svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
    search:      svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>'),
    scale:       svg('<path d="M12 3v18M5 7h14M8 21h8"/><path d="M5 7 2 13a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0z"/>'),
    send:        svg('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
    lock:        svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    unlock:      svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
    pencil:      svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    trash:       svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    download:    svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
    signature:   svg('<path d="M3 17c3 0 4-8 7-8s2 5 4 5 2-3 4-3"/><path d="M3 21h18"/>'),
    arrowUp:     svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
    play:        svg('<path d="m6 3 14 9-14 9z"/>'),
    undo:        svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-2"/>'),
  };

  // Inject sizing/alignment once. Icons scale to the text (1em) inline, and to a
  // fixed 16px inside buttons so every action button matches.
  if (typeof document !== 'undefined' && !document.getElementById('bps-icon-style')) {
    var st = document.createElement('style');
    st.id = 'bps-icon-style';
    st.textContent =
      '.ico{width:1em;height:1em;display:inline-block;vertical-align:-0.15em;' +
      'stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;' +
      'stroke-linejoin:round;flex:0 0 auto}' +
      'button .ico,.btn .ico,.action-btn .ico,[class*="btn"] .ico,.pbtn .ico{' +
      'width:16px;height:16px;margin-right:1px}';
    (document.head || document.documentElement).appendChild(st);
  }

  global.ICON = ICON;
})(typeof window !== 'undefined' ? window : this);
