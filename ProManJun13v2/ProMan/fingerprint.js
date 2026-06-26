/**
 * fingerprint.js — device identification for the Audit Logs.
 * ─────────────────────────────────────────────────────────────────────────
 * Loads FingerprintJS (served from /vendor/fingerprintjs), computes a stable
 * per-device visitor ID once, caches it in sessionStorage, and transparently
 * attaches it as the `X-Device-FP` header on outgoing API requests. The backend
 * (activityLogger) stores it so the Clinical Director can tell devices apart in
 * the Audit Logs "Device Information" column.
 *
 * Include early on any page that performs authenticated actions, e.g.:
 *   <script src="fingerprint.js"></script>
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'bps_device_fp';
  var FP_SRC = 'http://localhost:5000/vendor/fingerprintjs/fp.umd.min.js';

  // Current id (may be null until FingerprintJS resolves on first ever load).
  var deviceId = null;
  try { deviceId = sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY); } catch (_) {}

  // ── 1. Patch fetch to inject the header (works even before the id resolves) ──
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      // Only augment simple string/URL requests (the pattern used across this app).
      if (deviceId && (typeof input === 'string' || input instanceof URL)) {
        init = init || {};
        var h = init.headers;
        if (h instanceof Headers) {
          if (!h.has('X-Device-FP')) h.set('X-Device-FP', deviceId);
        } else {
          init.headers = Object.assign({}, h, { 'X-Device-FP': deviceId });
        }
      }
      return nativeFetch(input, init);
    };
  }

  // ── 2. Load FingerprintJS and resolve the visitor id (once per device) ──
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Failed to load FingerprintJS')); };
      document.head.appendChild(s);
    });
  }

  function init() {
    if (deviceId) return; // already known from a previous page
    loadScript(FP_SRC)
      .then(function () { return window.FingerprintJS.load(); })
      .then(function (fp) { return fp.get(); })
      .then(function (result) {
        deviceId = result.visitorId;
        try {
          sessionStorage.setItem(STORAGE_KEY, deviceId);
          localStorage.setItem(STORAGE_KEY, deviceId); // persists across sessions on this device
        } catch (_) {}
      })
      .catch(function (e) { /* non-fatal: audit just falls back to User-Agent */ console.debug('fingerprint:', e.message); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for callers that want the id directly.
  window.BPSDeviceFP = { get: function () { return deviceId; } };
})();
