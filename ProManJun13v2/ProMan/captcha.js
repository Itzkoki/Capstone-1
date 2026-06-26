/* ══════════════════════════════════════════════════════════════════
   BPS CAPTCHA + Teleconference OTP Module
   Exposes:
     BPSCaptcha.verify(action)           → Promise<boolean>
     BPSCaptcha.isCommunityVerified()    → boolean
     BPSCaptcha.setCommunityVerified()
     BPSTeleconfOtp.verify(userEmail)    → Promise<boolean>
     BPSTeleconfOtp.hasActiveSession()   → boolean
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const API_BASE = 'http://localhost:5000/api';
  const RECAPTCHA_SITE_KEY = window.RECAPTCHA_SITE_KEY || '6Le6iSotAAAAAJmV_yLm7hZn5m6wZa-3NKcXhBkF';
  // reCAPTCHA v2 (checkbox) fallback — used when the backend escalates a
  // suspicious v3 score. The backend returns the site key to use; this is the
  // default fallback if it doesn't.
  const RECAPTCHA_V2_SITE_KEY = window.RECAPTCHA_V2_SITE_KEY || '6Le5NSstAAAAAApJ7eoceEflarV5t7BM_ickUuiT';

  // Dev bypass disabled — real reCAPTCHA keys are configured.
  const IS_DEV_MODE = false;
  const COMMUNITY_TTL_MS = 4 * 60 * 60 * 1000; // 4-hour community session
  // Matches the server-side per-session OTP clearance window (TELECONF_OTP_
  // CLEARANCE_MIN, default 3 min) so the client re-prompts exactly when the
  // server clearance lapses (e.g. after the grace period).
  const TELECONF_INACTIVITY_MS = 3 * 60 * 1000; // 3 min

  // ── reCAPTCHA script loader ────────────────────────────────────────
  let _rcLoaded = false;
  let _rcLoading = false;
  const _rcCallbacks = [];

  function _loadRecaptcha() {
    return new Promise((resolve) => {
      if (_rcLoaded && window.grecaptcha) { resolve(); return; }
      _rcCallbacks.push(resolve);
      if (_rcLoading) return;
      _rcLoading = true;
      window.__bps_rc_ready = function () {
        _rcLoaded = true;
        _rcLoading = false;
        _rcCallbacks.forEach(cb => cb());
        _rcCallbacks.length = 0;
      };
      const s = document.createElement('script');
      s.src = `https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}&onload=__bps_rc_ready`;
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    });
  }

  // ── CAPTCHA modal ──────────────────────────────────────────────────
  function _buildCaptchaModal() {
    const overlay = document.createElement('div');
    overlay.className = 'bps-captcha-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Security Verification');
    overlay.innerHTML = `
      <div class="bps-captcha-modal">
        <div class="bps-captcha-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </div>
        <h2 class="bps-captcha-title">Security Verification</h2>
        <p class="bps-captcha-desc">Please confirm you are human to continue. This helps keep the platform safe.</p>
        <div class="bps-captcha-error" id="_bps_cap_err" role="alert" style="display:none;"></div>
        <div class="bps-captcha-actions">
          <button type="button" class="bps-captcha-btn bps-captcha-btn--cancel" id="_bps_cap_cancel">Cancel</button>
          <button type="button" class="bps-captcha-btn bps-captcha-btn--verify" id="_bps_cap_verify">
            <span id="_bps_cap_label">Verify I'm Human</span>
          </button>
        </div>
        <div class="bps-captcha-footer">
          Protected by <strong>reCAPTCHA</strong> &nbsp;·&nbsp;
          <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Privacy</a>
          &nbsp;·&nbsp;
          <a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer">Terms</a>
        </div>
      </div>
    `;
    return overlay;
  }

  // _lastClearance: server-signed JWT returned by /api/captcha/verify on success.
  // Valid for 5 minutes. Used by callers (e.g. login) instead of the reCAPTCHA
  // token, which is single-use and already consumed by /api/captcha/verify.
  let _lastToken     = null;
  let _lastClearance = null;

  function _execCaptcha(action) {
    return new Promise((resolve, reject) => {
      if (!window.grecaptcha) { reject(new Error('reCAPTCHA not available')); return; }
      // grecaptcha.ready() ensures the widget is fully initialised before execute()
      window.grecaptcha.ready(() => {
        window.grecaptcha.execute(RECAPTCHA_SITE_KEY, { action })
          .then(resolve)
          .catch(reject);
      });
    });
  }

  async function _verifyCaptchaWithBackend(token, action, version) {
    const res = await fetch(`${API_BASE}/captcha/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, action, version: version || 'v3' }),
    });
    // 429 (rate limited) still returns a JSON body with success:false + message.
    return res.json();
  }

  // ── reCAPTCHA v2 fallback challenge ─────────────────────────────────
  // Shows a modal with the "I'm not a robot" checkbox. Triggered when the
  // backend escalates a suspicious v3 score (challenge_required + version 'v2').
  // Resolves { success, error }. Verified token is checked against the v2
  // secret on the backend, which then issues the clearance token.
  function _runV2Challenge(siteKey, action) {
    return new Promise(async (resolve) => {
      try {
        if (!_rcLoaded) await _loadRecaptcha();
      } catch (_) {
        resolve({ success: false, error: 'Could not load the verification challenge. Please refresh and try again.' });
        return;
      }
      if (!window.grecaptcha || !window.grecaptcha.render) {
        resolve({ success: false, error: 'Verification challenge unavailable. Please refresh and try again.' });
        return;
      }

      const overlay = document.createElement('div');
      overlay.className = 'bps-captcha-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Additional Security Verification');
      overlay.innerHTML = `
        <div class="bps-captcha-modal">
          <div class="bps-captcha-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <h2 class="bps-captcha-title">One more step</h2>
          <p class="bps-captcha-desc">Our system needs an extra check. Please confirm you're human below.</p>
          <div class="bps-captcha-error" id="_bps_v2_err" role="alert" style="display:none;"></div>
          <div class="bps-captcha-v2-box" id="_bps_v2_widget"></div>
          <div class="bps-captcha-actions">
            <button type="button" class="bps-captcha-btn bps-captcha-btn--cancel" id="_bps_v2_cancel">Cancel</button>
          </div>
          <div class="bps-captcha-footer">
            Protected by <strong>reCAPTCHA</strong> &nbsp;·&nbsp;
            <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Privacy</a>
            &nbsp;·&nbsp;
            <a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer">Terms</a>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      document.body.style.overflow = 'hidden';

      const errEl     = overlay.querySelector('#_bps_v2_err');
      const cancelBtn = overlay.querySelector('#_bps_v2_cancel');
      const widgetBox = overlay.querySelector('#_bps_v2_widget');
      let   settled   = false;

      // If we were escalated from the v3 modal, its deferred cleanup resets
      // body.overflow shortly after; re-assert so the page stays locked.
      setTimeout(() => { if (!settled) document.body.style.overflow = 'hidden'; }, 250);

      function cleanup() {
        overlay.classList.remove('visible');
        setTimeout(() => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          document.body.style.overflow = '';
        }, 200);
      }
      function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }
      function finish(result) { if (settled) return; settled = true; cleanup(); resolve(result); }

      let widgetId = null;
      window.grecaptcha.ready(() => {
        try {
          widgetId = window.grecaptcha.render(widgetBox, {
            sitekey: siteKey || RECAPTCHA_V2_SITE_KEY,
            callback: async (v2Token) => {
              errEl.style.display = 'none';
              _logAudit('captcha_displayed', { action, version: 'v2' });
              try {
                const data = await _verifyCaptchaWithBackend(v2Token, action, 'v2');
                if (data.success) {
                  _lastToken     = v2Token;
                  _lastClearance = data.clearance_token || null;
                  _logAudit('captcha_success', { action, version: 'v2' });
                  finish({ success: true, error: null });
                } else {
                  _logAudit('captcha_failure', { action, version: 'v2', reason: data.message });
                  showErr(data.message || 'Verification failed. Please try the checkbox again.');
                  try { window.grecaptcha.reset(widgetId); } catch (_) {}
                }
              } catch (_) {
                showErr('Verification error. Please check your connection and try again.');
                try { window.grecaptcha.reset(widgetId); } catch (_) {}
              }
            },
            'expired-callback': () => { showErr('The challenge expired. Please check the box again.'); },
            'error-callback': () => { showErr('A challenge error occurred. Please try again.'); },
          });
        } catch (_) {
          finish({ success: false, error: 'Could not display the verification challenge. Please refresh and try again.' });
        }
      });

      cancelBtn.addEventListener('click', () => finish({ success: false, error: 'cancelled' }));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish({ success: false, error: 'cancelled' }); });

      requestAnimationFrame(() => {
        requestAnimationFrame(() => overlay.classList.add('visible'));
      });
    });
  }

  // Headless verify: runs reCAPTCHA + backend check with no modal UI.
  // Returns { success: boolean, error: string|null }.
  // Used by page-load gates (register, community) that supply their own UI.
  async function _executeAndVerify(action) {
    try {
      if (!_rcLoaded) await _loadRecaptcha();
      const token = await _execCaptcha(action);
      const data  = await _verifyCaptchaWithBackend(token, action);
      if (data.success) {
        _lastToken     = token;
        _lastClearance = data.clearance_token || null;
        _logAudit('captcha_success', { action, score: data.score });
        return { success: true, error: null };
      }
      // Suspicious v3 score → escalate to the v2 checkbox challenge.
      if (data.challenge_required && data.version === 'v2') {
        _logAudit('captcha_challenge_v2', { action, score: data.score });
        return await _runV2Challenge(data.site_key, action);
      }
      _logAudit('captcha_failure', { action, reason: data.message });
      return { success: false, error: data.message || 'Verification failed. Please try again.' };
    } catch (err) {
      return { success: false, error: err.message || 'Verification error. Please check your connection.' };
    }
  }

  function _logAudit(event, meta = {}) {
    try {
      const token = sessionStorage.getItem('bps_token');
      fetch(`${API_BASE}/captcha/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
        body: JSON.stringify({ event, ...meta }),
      }).catch(() => {});
    } catch (_) {}
  }

  // Returns Promise<boolean>: true = verified, false = cancelled
  function _captchaVerify(action = 'default') {
    return new Promise(async (resolve) => {
      // Start loading reCAPTCHA in background
      _loadRecaptcha().catch(() => {});

      const overlay = _buildCaptchaModal();
      document.body.appendChild(overlay);
      document.body.style.overflow = 'hidden';

      const errEl     = overlay.querySelector('#_bps_cap_err');
      const cancelBtn = overlay.querySelector('#_bps_cap_cancel');
      const verifyBtn = overlay.querySelector('#_bps_cap_verify');
      const label     = overlay.querySelector('#_bps_cap_label');

      function cleanup() {
        overlay.classList.remove('visible');
        setTimeout(() => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          document.body.style.overflow = '';
        }, 200);
      }

      function showErr(msg) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
      }

      cancelBtn.addEventListener('click', () => {
        cleanup();
        resolve(false);
      });

      // Close on overlay background click
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { cleanup(); resolve(false); }
      });

      verifyBtn.addEventListener('click', async () => {
        verifyBtn.disabled = true;
        cancelBtn.disabled = true;
        label.textContent = 'Verifying…';
        errEl.style.display = 'none';

        _logAudit('captcha_displayed', { action });

        try {
          let token;

          if (IS_DEV_MODE) {
            // Localhost dev mode — skip Google API, use dummy token the backend accepts
            token = 'dev-bypass-localhost';
          } else {
            // Ensure reCAPTCHA is ready
            if (!_rcLoaded) await _loadRecaptcha();
            try {
              token = await _execCaptcha(action);
            } catch (e) {
              throw new Error('Could not run the security check. Please refresh and try again.');
            }
          }

          const data = await _verifyCaptchaWithBackend(token, action);

          if (data.success) {
            _lastToken     = token;
            _lastClearance = data.clearance_token || null;
            _logAudit('captcha_success', { action, score: data.score });
            cleanup();
            resolve(true);
          } else if (data.challenge_required && data.version === 'v2') {
            // Suspicious v3 score → close this modal and run the v2 checkbox.
            _logAudit('captcha_challenge_v2', { action, score: data.score });
            cleanup();
            const v2 = await _runV2Challenge(data.site_key, action);
            resolve(!!v2.success);
          } else {
            _logAudit('captcha_failure', { action, reason: data.message });
            showErr(data.message || 'Verification failed. Please try again.');
            verifyBtn.disabled = false;
            cancelBtn.disabled = false;
            label.textContent = 'Try Again';
          }
        } catch (err) {
          _logAudit('captcha_failure', { action, reason: err.message });
          showErr(err.message || 'Verification failed. Please check your connection and try again.');
          verifyBtn.disabled = false;
          cancelBtn.disabled = false;
          label.textContent = 'Try Again';
        }
      });

      // Animate in
      requestAnimationFrame(() => {
        requestAnimationFrame(() => overlay.classList.add('visible'));
      });

      // Trap focus
      verifyBtn.focus();
    });
  }

  // ── Meetings page session helpers (sessionStorage, cleared on browser close / logout) ──
  function _isMeetingsVerified() {
    try { return !!JSON.parse(sessionStorage.getItem('bps_meetings_cap') || 'null'); }
    catch (_) { return false; }
  }
  function _setMeetingsVerified() {
    sessionStorage.setItem('bps_meetings_cap', JSON.stringify({ verified_at: Date.now() }));
  }

  // ── Psych Reports session helpers ──────────────────────────────────
  function _isPsychVerified() {
    try { return !!JSON.parse(sessionStorage.getItem('bps_psych_cap') || 'null'); }
    catch (_) { return false; }
  }
  function _setPsychVerified() {
    sessionStorage.setItem('bps_psych_cap', JSON.stringify({ verified_at: Date.now() }));
  }

  // ── Staff Management session helpers ───────────────────────────────
  function _isStaffMgmtVerified() {
    try { return !!JSON.parse(sessionStorage.getItem('bps_staffmgmt_cap') || 'null'); }
    catch (_) { return false; }
  }
  function _setStaffMgmtVerified() {
    sessionStorage.setItem('bps_staffmgmt_cap', JSON.stringify({ verified_at: Date.now() }));
  }

  // ── Payments session helpers ────────────────────────────────────────
  function _isPaymentsVerified() {
    try { return !!JSON.parse(sessionStorage.getItem('bps_payments_cap') || 'null'); }
    catch (_) { return false; }
  }
  function _setPaymentsVerified() {
    sessionStorage.setItem('bps_payments_cap', JSON.stringify({ verified_at: Date.now() }));
  }

  // ── Requests & Concerns session helpers ────────────────────────────
  function _isRequestsVerified() {
    try { return !!JSON.parse(sessionStorage.getItem('bps_requests_cap') || 'null'); }
    catch (_) { return false; }
  }
  function _setRequestsVerified() {
    sessionStorage.setItem('bps_requests_cap', JSON.stringify({ verified_at: Date.now() }));
  }

  // ── Case Management session helpers ────────────────────────────────
  function _isCaseVerified() {
    try { return !!JSON.parse(sessionStorage.getItem('bps_case_cap') || 'null'); }
    catch (_) { return false; }
  }
  function _setCaseVerified() {
    sessionStorage.setItem('bps_case_cap', JSON.stringify({ verified_at: Date.now() }));
  }

  // ── Community session helpers ──────────────────────────────────────
  function _isCommunityVerified() {
    try {
      const raw = sessionStorage.getItem('bps_community_cap');
      if (!raw) return false;
      const { ts } = JSON.parse(raw);
      return (Date.now() - ts) < COMMUNITY_TTL_MS;
    } catch (_) { return false; }
  }

  function _setCommunityVerified() {
    sessionStorage.setItem('bps_community_cap', JSON.stringify({ ts: Date.now() }));
  }

  // ── Teleconference OTP (PER-USER, PER-SESSION) ─────────────────────
  // Each conference is verified independently, keyed by BOTH the logged-in user
  // and the session id, so neither another conference NOR another participant
  // (e.g. on a shared browser) ever shares a grace/OTP state.
  function _tcUid() {
    try { return (JSON.parse(sessionStorage.getItem('bps_user') || '{}').id) || 'anon'; }
    catch (_) { return 'anon'; }
  }
  const _tcKey = (sessionId) => `bps_tc_otp_${_tcUid()}_${sessionId}`;

  function _hasActiveSession(sessionId) {
    if (!sessionId) return false;
    try {
      const raw = sessionStorage.getItem(_tcKey(sessionId));
      if (!raw) return false;
      const { verified_at, last_activity } = JSON.parse(raw);
      if (!verified_at) return false;
      const inactive = Date.now() - (last_activity || verified_at);
      return inactive < TELECONF_INACTIVITY_MS;
    } catch (_) { return false; }
  }

  function _touchSession(sessionId) {
    if (!sessionId) return;
    try {
      const raw = sessionStorage.getItem(_tcKey(sessionId));
      if (!raw) return;
      const data = JSON.parse(raw);
      data.last_activity = Date.now();
      sessionStorage.setItem(_tcKey(sessionId), JSON.stringify(data));
    } catch (_) {}
  }

  function _setSession(sessionId) {
    if (!sessionId) return;
    sessionStorage.setItem(_tcKey(sessionId), JSON.stringify({
      verified_at: Date.now(),
      last_activity: Date.now(),
    }));
  }

  // Clear one session's OTP state, or ALL of them (e.g. on logout) when no id.
  function _clearSession(sessionId) {
    if (sessionId) { sessionStorage.removeItem(_tcKey(sessionId)); return; }
    Object.keys(sessionStorage)
      .filter((k) => k.indexOf('bps_tc_otp') === 0)
      .forEach((k) => sessionStorage.removeItem(k));
  }

  // ── Clear EVERY captcha / OTP clearance from this session ───────────
  // Called on logout so a new user (or a re-login) must re-verify from
  // scratch. Single source of truth for all session keys this module sets.
  const _SESSION_KEYS = [
    'bps_community_cap',
    'bps_meetings_cap',
    'bps_psych_cap',
    'bps_staffmgmt_cap',
    'bps_payments_cap',
    'bps_requests_cap',
    'bps_case_cap',
    'bps_tc_otp',
  ];
  function _clearAllSessions() {
    _SESSION_KEYS.forEach((k) => sessionStorage.removeItem(k));
    // Per-session teleconference OTP keys (bps_tc_otp_<id>) — remove them all so
    // a new user / re-login must re-verify each conference from scratch.
    Object.keys(sessionStorage)
      .filter((k) => k.indexOf('bps_tc_otp') === 0)
      .forEach((k) => sessionStorage.removeItem(k));
    // Per-module access-OTP keys (bps_module_otp_<module>) — clear so a new
    // user / re-login must re-verify each gated module from scratch.
    Object.keys(sessionStorage)
      .filter((k) => k.indexOf('bps_module_otp_') === 0)
      .forEach((k) => sessionStorage.removeItem(k));
    _lastToken     = null;
    _lastClearance = null;
  }

  // Build the OTP modal DOM
  function _buildOtpModal(email) {
    const maskedEmail = email
      ? email.replace(/(.{2})(.*)(@.*)/, (_, a, b, c) => a + '*'.repeat(Math.min(b.length, 5)) + c)
      : 'your email';

    const overlay = document.createElement('div');
    overlay.className = 'bps-otp-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Email Verification');
    overlay.innerHTML = `
      <div class="bps-otp-modal">
        <div class="bps-otp-icon">
          <svg viewBox="0 0 24 24">
            <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
          </svg>
        </div>
        <h2 class="bps-otp-title">Email Verification</h2>
        <p class="bps-otp-desc">A 6-digit code was sent to</p>
        <p class="bps-otp-email-hint">${maskedEmail}</p>
        <div class="bps-otp-spam-note" style="display:flex;gap:8px;align-items:flex-start;text-align:left;background:#fffaf0;border:1px solid #fbd38d;color:#9c5b15;border-radius:8px;padding:10px 12px;margin:6px 0 4px;font-size:13px;line-height:1.45;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="flex-shrink:0;margin-top:1px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
          <span>If the verification code is not visible in your inbox, please check your <strong>Spam</strong> or <strong>Junk</strong> folder.</span>
        </div>
        <div class="bps-otp-error" id="_bps_otp_err" role="alert" style="display:none;"></div>
        <div class="bps-otp-input-row" id="_bps_otp_row" aria-label="Enter 6-digit code">
          ${[0,1,2,3,4,5].map(i => `<input type="text" inputmode="numeric" maxlength="1" class="bps-otp-digit" id="_bps_d${i}" aria-label="Digit ${i+1}">`).join('')}
        </div>
        <div class="bps-otp-timer" id="_bps_otp_timer">Code expires in <span id="_bps_otp_countdown">2:00</span></div>
        <div class="bps-otp-actions">
          <button type="button" class="bps-otp-btn bps-otp-btn--verify" id="_bps_otp_verify" disabled>
            <span id="_bps_otp_label">Verify Code</span>
          </button>
        </div>
        <div class="bps-otp-resend">
          Didn't receive it? <button type="button" id="_bps_otp_resend" disabled>Resend Code</button>
        </div>
        <div>
          <span class="bps-otp-cancel-link" id="_bps_otp_cancel" role="button" tabindex="0">Cancel</span>
        </div>
      </div>
    `;
    return overlay;
  }

  async function _teleconfVerify(userEmail, sessionId) {
    return new Promise(async (resolve) => {
      const authToken = sessionStorage.getItem('bps_token');
      if (!authToken) { resolve(false); return; }
      if (!sessionId) { resolve(false); return; } // per-session OTP requires a session

      // Attempt to send OTP — we always show the modal regardless of send result
      // so the user can see an error and retry via "Resend Code" instead of silently failing.
      let initialSendOk  = false;
      let initialSendMsg = '';
      try {
        const sendRes  = await fetch(`${API_BASE}/teleconference/otp/send`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        });
        const sendData = await sendRes.json();
        initialSendOk  = !!sendData.success;
        if (!initialSendOk) initialSendMsg = sendData.message || 'Failed to send verification code.';
        else _logAudit('otp_generated', { context: 'teleconference' });
      } catch (_) {
        initialSendMsg = 'Network error. Please check your connection.';
      }

      const overlay = _buildOtpModal(userEmail);
      document.body.appendChild(overlay);
      document.body.style.overflow = 'hidden';

      const errEl     = overlay.querySelector('#_bps_otp_err');
      const verifyBtn = overlay.querySelector('#_bps_otp_verify');
      const label     = overlay.querySelector('#_bps_otp_label');
      const resendBtn = overlay.querySelector('#_bps_otp_resend');
      const cancelEl  = overlay.querySelector('#_bps_otp_cancel');
      const timerEl   = overlay.querySelector('#_bps_otp_countdown');
      const timerBox  = overlay.querySelector('#_bps_otp_timer');
      const digits    = Array.from({ length: 6 }, (_, i) => overlay.querySelector(`#_bps_d${i}`));

      let resendTimer = null;
      function cleanup() {
        clearInterval(countdownTimer);
        clearInterval(resendTimer);
        overlay.classList.remove('visible');
        setTimeout(() => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          document.body.style.overflow = '';
        }, 200);
      }

      // Small countdown on the Resend button, tied to the server's rate limit:
      // the button stays disabled and shows "Resend in Ns" until the cooldown ends.
      const _resendBaseLabel = resendBtn.textContent;
      function startResendCountdown(seconds) {
        clearInterval(resendTimer);
        let remaining = Math.max(0, Math.ceil(seconds));
        resendBtn.disabled = true;
        const render = () => {
          if (remaining <= 0) {
            clearInterval(resendTimer);
            resendBtn.disabled = false;
            resendBtn.textContent = _resendBaseLabel;
            return;
          }
          resendBtn.textContent = `Resend in ${remaining}s`;
          remaining -= 1;
        };
        render();
        resendTimer = setInterval(render, 1000);
      }

      // ── countdown timer (2 min, matching the server's OTP expiry) ──
      let expiresAt = Date.now() + 2 * 60 * 1000;
      let countdownTimer = setInterval(() => {
        const rem = Math.max(0, expiresAt - Date.now());
        const m = Math.floor(rem / 60000);
        const s = Math.floor((rem % 60000) / 1000);
        const cd = document.getElementById('_bps_otp_countdown');
        if (cd) cd.textContent = `${m}:${s.toString().padStart(2, '0')}`;
        if (rem < 60000) timerBox.classList.add('urgent');
        if (rem === 0) {
          clearInterval(countdownTimer);
          timerBox.textContent = 'Code has expired. Please request a new one.';
          timerBox.classList.add('urgent');
          verifyBtn.disabled = true;
        }
      }, 1000);

      // The first resend is allowed immediately (no initial cooldown). The 2-minute
      // countdown only starts AFTER the user clicks Resend (see doResend). If the
      // initial send failed, surface the error so they can retry right away.
      if (initialSendOk) {
        resendBtn.disabled = false;
      } else {
        showErr(initialSendMsg || 'Could not send verification code. Please tap "Resend Code" to try again.');
        resendBtn.disabled = false;
      }

      // ── digit inputs ──
      function getCode() { return digits.map(d => d.value).join(''); }

      function updateVerifyState() {
        const code = getCode();
        verifyBtn.disabled = code.length !== 6;
      }

      digits.forEach((d, i) => {
        d.addEventListener('input', () => {
          d.value = d.value.replace(/\D/g, '').slice(-1);
          d.classList.toggle('filled', d.value.length === 1);
          if (d.value && i < 5) digits[i + 1].focus();
          updateVerifyState();
        });
        d.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !d.value && i > 0) digits[i - 1].focus();
        });
        d.addEventListener('paste', (e) => {
          const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
          if (text.length >= 6) {
            e.preventDefault();
            digits.forEach((dd, idx) => { dd.value = text[idx] || ''; dd.classList.toggle('filled', !!dd.value); });
            digits[Math.min(5, text.length - 1)].focus();
            updateVerifyState();
          }
        });
      });

      function showErr(msg) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
      }

      async function doResend() {
        resendBtn.disabled = true;
        errEl.style.display = 'none';
        timerBox.classList.remove('urgent');
        digits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
        verifyBtn.disabled = true;

        try {
          const r = await fetch(`${API_BASE}/teleconference/otp/send`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
          });
          const rd = await r.json();
          if (rd.success) {
            expiresAt = Date.now() + 2 * 60 * 1000;
            clearInterval(countdownTimer);
            countdownTimer = setInterval(() => {
              const rem = Math.max(0, expiresAt - Date.now());
              const m = Math.floor(rem / 60000);
              const s = Math.floor((rem % 60000) / 1000);
              const cd = document.getElementById('_bps_otp_countdown');
              if (cd) cd.textContent = `${m}:${s.toString().padStart(2, '0')}`;
              if (rem < 60000) timerBox.classList.add('urgent');
            }, 1000);
            timerBox.textContent = 'Code expires in ';
            timerBox.appendChild(Object.assign(document.createElement('span'), { id: '_bps_otp_countdown', textContent: '2:00' }));
            _logAudit('otp_resent', { context: 'teleconference' });
            // Show the small countdown tied to the server's 2-minute cooldown.
            startResendCountdown(rd.resend_cooldown_seconds || 120);
          } else {
            // Honor the server-enforced cooldown (HTTP 429 + retryAfter seconds).
            const wait = (r.status === 429 && rd.retryAfter) ? rd.retryAfter : 120;
            showErr(rd.message || 'Failed to resend code. Please try again.');
            startResendCountdown(wait);
          }
        } catch (_) {
          showErr('Could not resend. Please check your connection.');
          resendBtn.disabled = false;
        }
        digits[0].focus();
      }

      async function doVerify() {
        const code = getCode();
        if (code.length !== 6) return;
        verifyBtn.disabled = true;
        label.textContent = 'Verifying…';
        errEl.style.display = 'none';

        try {
          const r = await fetch(`${API_BASE}/teleconference/otp/verify`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ otp: code, session_id: sessionId }),
          });
          const data = await r.json();

          if (data.success) {
            _logAudit('otp_verification_success', { context: 'teleconference' });
            _setSession(sessionId);
            cleanup();
            resolve(true);
          } else {
            _logAudit('otp_verification_failure', { context: 'teleconference' });
            showErr(data.message || 'Invalid or expired code. Please try again.');
            verifyBtn.disabled = false;
            label.textContent = 'Verify Code';
            digits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
            digits[0].focus();
          }
        } catch (_) {
          showErr('Verification failed. Please check your connection.');
          verifyBtn.disabled = false;
          label.textContent = 'Verify Code';
        }
      }

      verifyBtn.addEventListener('click', doVerify);
      resendBtn.addEventListener('click', doResend);
      cancelEl.addEventListener('click', () => { cleanup(); resolve(false); });
      cancelEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { cleanup(); resolve(false); } });

      // Animate in
      requestAnimationFrame(() => {
        requestAnimationFrame(() => overlay.classList.add('visible'));
      });

      digits[0].focus();
    });
  }

  // ── Module-access email OTP (PER-MODULE, PER-SESSION) ──────────────
  // Gates sensitive staff-only modules (Case Management, Staff Management,
  // Payment Verification) behind an email OTP. Verified state is held in
  // sessionStorage so it persists for the browser session and clears on logout.
  function _moduleKey(moduleKey) { return `bps_module_otp_${moduleKey}`; }

  function _isModuleVerified(moduleKey) {
    try { return !!JSON.parse(sessionStorage.getItem(_moduleKey(moduleKey)) || 'null'); }
    catch (_) { return false; }
  }
  function _setModuleVerified(moduleKey) {
    sessionStorage.setItem(_moduleKey(moduleKey), JSON.stringify({ verified_at: Date.now() }));
  }

  // Sends an OTP for the module, shows the shared 6-digit OTP modal, and
  // resolves Promise<boolean> (true = verified, false = cancelled).
  async function _moduleOtpVerify(moduleKey) {
    return new Promise(async (resolve) => {
      const authToken = sessionStorage.getItem('bps_token');
      if (!authToken) { resolve(false); return; }

      let userEmail = '';
      try { userEmail = (JSON.parse(sessionStorage.getItem('bps_user') || '{}').email) || ''; } catch (_) {}

      const _send = () => fetch(`${API_BASE}/module-otp/send`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: moduleKey }),
      });

      // Send the first code; show the modal regardless so errors can be retried.
      let initialSendOk = false, initialSendMsg = '';
      try {
        const sendData = await (await _send()).json();
        initialSendOk = !!sendData.success;
        if (!initialSendOk) initialSendMsg = sendData.message || 'Failed to send verification code.';
        else _logAudit('otp_generated', { context: moduleKey });
      } catch (_) {
        initialSendMsg = 'Network error. Please check your connection.';
      }

      const overlay = _buildOtpModal(userEmail);
      document.body.appendChild(overlay);
      document.body.style.overflow = 'hidden';

      const errEl     = overlay.querySelector('#_bps_otp_err');
      const verifyBtn = overlay.querySelector('#_bps_otp_verify');
      const label     = overlay.querySelector('#_bps_otp_label');
      const resendBtn = overlay.querySelector('#_bps_otp_resend');
      const cancelEl  = overlay.querySelector('#_bps_otp_cancel');
      const timerBox  = overlay.querySelector('#_bps_otp_timer');
      const digits    = Array.from({ length: 6 }, (_, i) => overlay.querySelector(`#_bps_d${i}`));

      let resendTimer = null;
      function cleanup() {
        clearInterval(countdownTimer);
        clearInterval(resendTimer);
        overlay.classList.remove('visible');
        setTimeout(() => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          document.body.style.overflow = '';
        }, 200);
      }
      function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }

      const _resendBaseLabel = resendBtn.textContent;
      function startResendCountdown(seconds) {
        clearInterval(resendTimer);
        let remaining = Math.max(0, Math.ceil(seconds));
        resendBtn.disabled = true;
        const render = () => {
          if (remaining <= 0) { clearInterval(resendTimer); resendBtn.disabled = false; resendBtn.textContent = _resendBaseLabel; return; }
          resendBtn.textContent = `Resend in ${remaining}s`;
          remaining -= 1;
        };
        render();
        resendTimer = setInterval(render, 1000);
      }

      let expiresAt = Date.now() + 2 * 60 * 1000;
      function startCountdown() {
        return setInterval(() => {
          const rem = Math.max(0, expiresAt - Date.now());
          const m = Math.floor(rem / 60000);
          const s = Math.floor((rem % 60000) / 1000);
          const cd = document.getElementById('_bps_otp_countdown');
          if (cd) cd.textContent = `${m}:${s.toString().padStart(2, '0')}`;
          if (rem < 60000) timerBox.classList.add('urgent');
          if (rem === 0) {
            clearInterval(countdownTimer);
            timerBox.textContent = 'Code has expired. Please request a new one.';
            timerBox.classList.add('urgent');
            verifyBtn.disabled = true;
          }
        }, 1000);
      }
      let countdownTimer = startCountdown();

      if (initialSendOk) { resendBtn.disabled = false; }
      else { showErr(initialSendMsg || 'Could not send verification code. Please tap "Resend Code" to try again.'); resendBtn.disabled = false; }

      function getCode() { return digits.map(d => d.value).join(''); }
      function updateVerifyState() { verifyBtn.disabled = getCode().length !== 6; }

      digits.forEach((d, i) => {
        d.addEventListener('input', () => {
          d.value = d.value.replace(/\D/g, '').slice(-1);
          d.classList.toggle('filled', d.value.length === 1);
          if (d.value && i < 5) digits[i + 1].focus();
          updateVerifyState();
        });
        d.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !d.value && i > 0) digits[i - 1].focus(); });
        d.addEventListener('paste', (e) => {
          const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
          if (text.length >= 6) {
            e.preventDefault();
            digits.forEach((dd, idx) => { dd.value = text[idx] || ''; dd.classList.toggle('filled', !!dd.value); });
            digits[Math.min(5, text.length - 1)].focus();
            updateVerifyState();
          }
        });
      });

      async function doResend() {
        resendBtn.disabled = true;
        errEl.style.display = 'none';
        timerBox.classList.remove('urgent');
        digits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
        verifyBtn.disabled = true;
        try {
          const r  = await _send();
          const rd = await r.json();
          if (rd.success) {
            expiresAt = Date.now() + 2 * 60 * 1000;
            clearInterval(countdownTimer);
            timerBox.textContent = 'Code expires in ';
            timerBox.appendChild(Object.assign(document.createElement('span'), { id: '_bps_otp_countdown', textContent: '2:00' }));
            countdownTimer = startCountdown();
            _logAudit('otp_resent', { context: moduleKey });
            startResendCountdown(rd.resend_cooldown_seconds || 120);
          } else {
            const wait = (r.status === 429 && rd.retryAfter) ? rd.retryAfter : 120;
            showErr(rd.message || 'Failed to resend code. Please try again.');
            startResendCountdown(wait);
          }
        } catch (_) {
          showErr('Could not resend. Please check your connection.');
          resendBtn.disabled = false;
        }
        digits[0].focus();
      }

      async function doVerify() {
        const code = getCode();
        if (code.length !== 6) return;
        verifyBtn.disabled = true;
        label.textContent = 'Verifying…';
        errEl.style.display = 'none';
        try {
          const r = await fetch(`${API_BASE}/module-otp/verify`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ otp: code, module: moduleKey }),
          });
          const data = await r.json();
          if (data.success) {
            _logAudit('otp_verification_success', { context: moduleKey });
            _setModuleVerified(moduleKey);
            cleanup();
            resolve(true);
          } else {
            _logAudit('otp_verification_failure', { context: moduleKey });
            showErr(data.message || 'Invalid or expired code. Please try again.');
            verifyBtn.disabled = false;
            label.textContent = 'Verify Code';
            digits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
            digits[0].focus();
          }
        } catch (_) {
          showErr('Verification failed. Please check your connection.');
          verifyBtn.disabled = false;
          label.textContent = 'Verify Code';
        }
      }

      verifyBtn.addEventListener('click', doVerify);
      resendBtn.addEventListener('click', doResend);
      cancelEl.addEventListener('click', () => { cleanup(); resolve(false); });
      cancelEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { cleanup(); resolve(false); } });

      requestAnimationFrame(() => { requestAnimationFrame(() => overlay.classList.add('visible')); });
      digits[0].focus();
    });
  }

  // ── Public API ─────────────────────────────────────────────────────
  window.BPSCaptcha = {
    verify: _captchaVerify,                      // shows modal UI → Promise<boolean>
    executeAndVerify: _executeAndVerify,          // headless, no modal → Promise<{success,error}>
    getClearanceToken: () => _lastClearance,      // server-signed JWT; use this with login, NOT the raw reCAPTCHA token
    isCommunityVerified: _isCommunityVerified,
    setCommunityVerified: _setCommunityVerified,
    isMeetingsVerified: _isMeetingsVerified,
    setMeetingsVerified: _setMeetingsVerified,
    isPsychVerified: _isPsychVerified,
    setPsychVerified: _setPsychVerified,
    isStaffMgmtVerified: _isStaffMgmtVerified,
    setStaffMgmtVerified: _setStaffMgmtVerified,
    isPaymentsVerified: _isPaymentsVerified,
    setPaymentsVerified: _setPaymentsVerified,
    isRequestsVerified: _isRequestsVerified,
    setRequestsVerified: _setRequestsVerified,
    isCaseVerified: _isCaseVerified,
    setCaseVerified: _setCaseVerified,
    clearAllSessions: _clearAllSessions,
  };

  window.BPSTeleconfOtp = {
    verify: _teleconfVerify,
    hasActiveSession: _hasActiveSession,
    touchSession: _touchSession,
    clearSession: _clearSession,
  };

  // Email-OTP gate for sensitive staff-only modules.
  window.BPSModuleOtp = {
    verify: _moduleOtpVerify,             // (moduleKey) → Promise<boolean>
    isVerified: _isModuleVerified,        // (moduleKey) → boolean
    setVerified: _setModuleVerified,      // (moduleKey)
  };
})();
