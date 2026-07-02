/* ══════════════════════════════════════════════════════════
   Teleconference — all page logic (extracted from meetings.html)
   ══════════════════════════════════════════════════════════ */

const API = '/api';
const token = BPSSession.getToken();
const user = BPSSession.getUser();
const isStaffUser = user.role && user.role !== 'client';

let currentFilter = '';
let currentSession = null;
let twilioRoom = null;
let localTracks = [];

// ── Live-call seat lock ──
// connectionToken is a per-join secret the server returns ONLY to this device.
// We send it on every join/reconnect and in the heartbeat so the server knows
// THIS device owns the seat. A second device using the same account never
// receives it, so it cannot keep (or steal) the seat.
let currentConnectionToken = null;
let seatHeartbeatTimer = null;

// Durable reconnect token, persisted in localStorage so it survives a refresh
// or browser crash. Lets THIS device reclaim its seat after an accidental
// disconnect without re-running OTP. Cleared on an intentional leave.
let intentionalLeave = false;
// Set when the host ends the call for everyone (detected via poll or a
// SESSION_ENDED response). Suppresses auto-reconnect so we don't fight the end.
let sessionWasEnded = false;

// ── Auto-reconnect throttle ──
// A flaky network can drop and restore the Twilio room repeatedly. Without a
// guard, EVERY cycle fired a "Session Active"/"Reconnected" toast and immediately
// kicked off another reconnect, so the popups never stopped until a manual
// refresh (which just reset this state). We now: (a) allow only one in-flight
// attempt, (b) back off between tries, (c) cap rapid retries, and (d) reset the
// budget only once the call has stayed up long enough to be considered stable.
let isReconnecting = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let stabilityTimer = null;
const MAX_RECONNECT_ATTEMPTS = 5;
const STABLE_AFTER_MS = 20000;
function stopReconnecting() {
  isReconnecting = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}
function resetReconnectState() {
  stopReconnecting();
  reconnectAttempts = 0;
  if (stabilityTimer) { clearTimeout(stabilityTimer); stabilityTimer = null; }
}
// After a successful (re)connect: if the call stays up for STABLE_AFTER_MS, the
// drop was a one-off, so refill the retry budget — a much later, unrelated drop
// still gets its full set of attempts.
function markConnectedStable() {
  if (stabilityTimer) clearTimeout(stabilityTimer);
  stabilityTimer = setTimeout(() => { reconnectAttempts = 0; }, STABLE_AFTER_MS);
}

// localStorage is SHARED across all tabs/windows of the browser, so the key must
// include the user id — otherwise two accounts joining the same conference in
// one browser would overwrite each other's reconnect token (device binding).
function rcUid() { try { return (JSON.parse(sessionStorage.getItem('bps_user') || '{}').id) || 'anon'; } catch (_) { return 'anon'; } }
const rcKey = (sid) => `bps_tc_rc_${rcUid()}_${sid}`;
function saveReconnectToken(sid, t) { try { if (t) localStorage.setItem(rcKey(sid), t); } catch (_) {} }
function loadReconnectToken(sid)    { try { return localStorage.getItem(rcKey(sid)); } catch (_) { return null; } }
function clearReconnectToken(sid)   { try { localStorage.removeItem(rcKey(sid)); } catch (_) {} }

// Attempt to silently reclaim the seat after an unexpected disconnect, using the
// durable reconnect token. Falls back to a manual rejoin prompt if the server
// can't verify us (NEEDS_REJOIN / NEEDS_OTP) — the intruder path.
async function attemptReconnect(sessionId) {
  if (sessionWasEnded || intentionalLeave) return;
  if (isReconnecting) return; // an attempt is already scheduled/in-flight
  const rt = loadReconnectToken(sessionId);
  if (!rt) { promptManualRejoin(); return; }

  // Bounded retries: after repeated rapid drops, give up with a SINGLE prompt
  // instead of looping reconnect toasts forever.
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    resetReconnectState();
    promptManualRejoin();
    return;
  }

  isReconnecting = true;
  reconnectAttempts++;
  // Exponential backoff: ~1s, 2s, 4s, 8s, 15s (cap). This also spaces out the
  // toasts so a genuinely recovering connection settles instead of flapping.
  const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 15000);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (sessionWasEnded || intentionalLeave) { isReconnecting = false; return; }
    try {
      const data = await apiFetch(`/teleconference/${sessionId}/reconnect`, {
        method: 'POST',
        body: JSON.stringify({ reconnectToken: rt }),
      });
      // The host ended the call while we were dropped — don't keep trying.
      if (data && data.code === 'SESSION_ENDED') { isReconnecting = false; onHostEnded(); return; }
      if (data && data.success && data.data) {
        currentSession = data.data.session;
        // connectToRoom shows the single "Reconnected" toast on this path.
        await connectToRoom(data.data, { isReconnect: true });
        isReconnecting = false;
        return;
      }
      isReconnecting = false;
      promptManualRejoin();
    } catch (_) {
      isReconnecting = false;
      promptManualRejoin();
    }
  }, delay);
}

// Called when the HOST has ended the call for everyone. Notifies this
// participant and returns them to the post-session page (the sessions list).
function onHostEnded() {
  if (sessionWasEnded) return;
  sessionWasEnded = true;
  stopSeatHeartbeat();
  resetReconnectState(); // stop any in-flight auto-reconnect + its toasts
  if (currentSession) clearReconnectToken(currentSession.id);
  BPSToast.info('The host has ended the teleconference for everyone.', { title: 'Call Ended' });
  leaveSession(); // tears down the call UI and returns to the sessions list
}

function promptManualRejoin() {
  BPSToast.error('You were disconnected. Please rejoin the session.', { title: 'Disconnected' });
}

function startSeatHeartbeat() {
  stopSeatHeartbeat();
  if (!currentConnectionToken || !currentSession) return;
  seatHeartbeatTimer = setInterval(async () => {
    if (!currentConnectionToken || !currentSession) return;
    try {
      const r = await apiFetch(`/teleconference/${currentSession.id}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ connectionToken: currentConnectionToken }),
      });
      // SEAT_LOST means this account joined on another device and took the seat.
      if (r && r.code === 'SEAT_LOST') {
        stopSeatHeartbeat();
        try { if (twilioRoom) twilioRoom.disconnect(); } catch (_) {}
        BPSToast.error('You were disconnected because this account joined on another device.', { title: 'Disconnected' });
      }
    } catch (_) { /* transient network error — keep trying */ }
  }, 10000);
}

function stopSeatHeartbeat() {
  if (seatHeartbeatTimer) { clearInterval(seatHeartbeatTimer); seatHeartbeatTimer = null; }
}

// Per-participant camera/mic state, keyed by Twilio identity (the user's full name).
// { [identity]: { cam: boolean, mic: boolean } }
let mediaState = {};

// Per-participant speaking state for voice-activity detection, keyed by identity.
let speakingState = {};

let selectedStaff = [];          // [{id, label}] chosen additional staff (max 3)
let pollTimer = null;            // interval handle for real-time polling
let awaitingAdmission = false;   // true while sitting in the waiting room
let recordingPromptOpen = false; // guard so the consent popup shows once per request
let recordingResponded = false;  // whether the client already answered the current request
let lastMessageId = 0;           // highest chat message id rendered so far

// ===== HELPERS =====
async function apiFetch(url, opts = {}) {
  const res = await fetch(`${API}${url}`, {
    ...opts,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers },
  });
  if (res.status === 401) window.location.href = 'login.html';
  return res.json();
}

function showToast(msg) {
  BPSToast.success(msg);
}

// If the user closes/reloads the tab while in a call, tell the backend they
// left so they drop from the roster (keepalive lets the request outlive unload).
window.addEventListener('beforeunload', () => {
  if (currentSession && twilioRoom) {
    try {
      fetch(`${API}/teleconference/${currentSession.id}/leave`, {
        method: 'POST', keepalive: true,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      }).catch(() => {});
    } catch (e) { /* best-effort */ }
  }
});

function timeAgo(d) {
  if (!d) return '—';
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ===== NAVBAR ===== (rendered by shared navbar.js — role-aware dropdowns)
(function() {
  if (user.role !== 'client') {
    const b = document.getElementById('btn-new-session');
    if (b) b.style.display = 'inline-flex';
  }
})();

// ===== CREATE FORM =====
// Back-compat: the create form now lives in the Schedule-a-Meeting modal.
function toggleCreateForm() { openScheduleModal(); }

async function loadClients() {
  try {
    const json = await apiFetch('/teleconference/clients');
    if (json.success && json.data.length) {
      const select = document.getElementById('client-select');
      json.data.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        // Only verified clients may be assigned to a teleconference.
        const verified = c.is_verified === true || c.is_verified === 'true';
        opt.textContent = `${c.full_name} (${c.email})${verified ? '' : ' — Unverified'}`;
        if (!verified) {
          opt.disabled = true;
          opt.title = 'This user must verify their account before they can be assigned.';
        }
        select.appendChild(opt);
      });
    }
  } catch (e) { console.error('Failed to load clients:', e); }
}

async function loadStaff() {
  try {
    const staffJson = await apiFetch('/teleconference/staff');
    const staffSelect = document.getElementById('staff-select');
    if (staffJson.success && staffJson.data && staffJson.data.length) {
      staffJson.data.forEach(s => {
        if (s.id !== user.id) { // exclude current user (session creator/host)
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = `${s.full_name} (${s.role})`;
          staffSelect.appendChild(opt);
        }
      });
    }
  } catch (e) {
    console.error('Failed to load staff:', e);
  }
}

// ===== STAFF PICKER (dropdown + add/remove, max 3) =====
function addStaff() {
  const sel = document.getElementById('staff-select');
  const id = parseInt(sel.value, 10);
  if (!sel.value || isNaN(id)) {
    BPSToast.warning('Please choose a staff member first.', { title: 'No Staff Selected' });
    return;
  }
  if (selectedStaff.length >= 3) {
    BPSToast.warning('You can add up to 3 staff members.', { title: 'Staff Limit' });
    return;
  }
  if (selectedStaff.some(s => s.id === id)) {
    BPSToast.warning('That staff member is already added.', { title: 'Already Added' });
    return;
  }
  const label = sel.options[sel.selectedIndex].textContent;
  selectedStaff.push({ id, label });
  sel.value = '';
  renderSelectedStaff();
}

function removeStaff(id) {
  selectedStaff = selectedStaff.filter(s => s.id !== id);
  renderSelectedStaff();
}

function renderSelectedStaff() {
  const list = document.getElementById('selected-staff-list');
  if (!list) return;
  if (!selectedStaff.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = selectedStaff.map(s => `
    <div class="staff-chip">
      <span class="staff-chip__name">${escHtml(s.label)}</span>
      <button type="button" class="staff-chip__remove" onclick="removeStaff(${s.id})" title="Remove">&times;</button>
    </div>
  `).join('');
}

async function createSession() {
  const title = document.getElementById('session-title').value.trim();
  if (!title) { BPSToast.warning('Session title is required.', { title: 'Missing Title' }); return; }

  const clientId = document.getElementById('client-select').value || null;
  if (!clientId) { BPSToast.warning('Please assign a client to this session.', { title: 'No Client Selected' }); return; }

  const staffIds = selectedStaff.map(s => s.id);
  if (staffIds.length > 3) { BPSToast.warning('You can add up to 3 additional staff members.', { title: 'Staff Limit' }); return; }

  const data = await apiFetch('/teleconference', {
    method: 'POST',
    body: JSON.stringify({ title, client_id: parseInt(clientId), additional_staff: staffIds }),
  });

  if (data.success) {
    document.getElementById('session-title').value = '';
    document.getElementById('client-select').value = '';
    closeScheduleModal();
    showToast('Session created successfully!');
    if (isStaffUser) loadStaffDashboard(); else loadSessions();
  } else {
    showToast(data.message || 'Failed to create session.');
  }
}

// ===== SESSION LIST =====
function filterSessions(status, btn) {
  currentFilter = status;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadSessions();
}

async function loadSessions() {
  const url = currentFilter ? `/teleconference?status=${currentFilter}` : '/teleconference';
  const data = await apiFetch(url);
  const list = document.getElementById('sessions-list');

  if (!data.success || !data.data.length) {
    list.innerHTML = `
      <div class="empty-state">
        <i data-lucide="video-off" style="width:54px;height:54px;color:#cbd3e1;"></i>
        <div class="empty-state__title">No sessions found</div>
        <div class="empty-state__text">${isStaffUser ? 'Create a new consultation session to get started.' : 'You have no consultation sessions scheduled.'}</div>
      </div>`;
    lucide.createIcons();
    return;
  }

  list.innerHTML = data.data.map(s => {
    const statusClass = `meeting-status--${s.session_status}`;
    const showJoin = s.session_status === 'scheduled' || s.session_status === 'active';
    return `
      <div class="meeting-card" onclick="openSession(${s.id})">
        <div class="meeting-card__header">
          <h3 class="meeting-card__title">
            <i data-lucide="video" style="width:18px;height:18px;color:var(--green-primary);margin-right:6px;"></i>
            ${escHtml(s.meeting_title || 'Consultation Session')}
          </h3>
          <span class="meeting-status ${statusClass}">${s.session_status}</span>
        </div>
        <div class="meeting-card__details">
          <div class="detail-chip">
            <i data-lucide="user-round"></i>
            ${escHtml(s.psychologist_name || 'Unassigned')}
          </div>
          <div class="detail-chip">
            <i data-lucide="users"></i>
            Client: ${escHtml(s.client_name || 'Not assigned')}
          </div>
          <div class="detail-chip">
            <i data-lucide="clock"></i>
            ${timeAgo(s.created_at)}
          </div>
          ${s.recording_enabled ? '<div class="detail-chip detail-chip--rec"><span class="rec-dot"></span>Recording</div>' : ''}
        </div>
        <div class="meeting-card__actions" onclick="event.stopPropagation()">
          ${showJoin ? `<button class="btn-sm btn-sm--primary" onclick="openSession(${s.id})">Join</button>` : ''}
          ${s.psychologist_id === user.id && s.session_status !== 'ended' ? `<button class="btn-sm btn-sm--danger" onclick="endSessionDirect(${s.id})">End</button>` : ''}
        </div>
      </div>`;
  }).join('');
  lucide.createIcons();
}

// ===== SESSION DETAIL =====
// Entry point for the "Join" button on a meeting card (and the notification
// deep-link). Opening the teleconference session UI requires a CAPTCHA FIRST —
// the user must pass it before the session view (with its "Join Session"
// button) is ever shown. Returns false if the user did not pass the check.
async function openSession(sessionId) {
  // Per-session OTP gate: require a fresh email OTP for THIS conference before
  // its UI is shown. (CAPTCHA removed from teleconference.) If still within this
  // session's OTP window, no re-prompt. Each conference is verified separately.
  if (!BPSTeleconfOtp.hasActiveSession(sessionId)) {
    const email = (BPSSession.getUser() || {}).email || '';
    const ok = await BPSTeleconfOtp.verify(email, sessionId);
    if (!ok) return false;
  }

  const data = await apiFetch(`/teleconference/${sessionId}`);
  if (!data.success) { BPSToast.error(data.message || 'Failed to load session.', { title: 'Session Error' }); return false; }

  currentSession = data.data;
  const amHost = currentSession.am_i_host;

  // reset per-open state
  awaitingAdmission = false;
  sessionWasEnded = false;
  recordingPromptOpen = false;
  recordingResponded = (currentSession.recording_response !== null && currentSession.recording_response !== undefined);
  lastMessageId = 0;

  // Update UI — hide whichever landing view this user has (staff list or
  // client dashboard) and show the in-call detail view.
  document.getElementById('sessions-list-view').style.display = 'none';
  const _cdv = document.getElementById('client-dashboard-view');
  if (_cdv) _cdv.style.display = 'none';
  document.getElementById('session-detail-view').style.display = 'block';

  document.getElementById('session-title-display').textContent = currentSession.meeting_title || 'Consultation Session';
  document.getElementById('session-subtitle').textContent =
    `Teleconference · ${currentSession.client_name ? 'Client: ' + currentSession.client_name : 'Room: Virtual'}`;
  const badge = document.getElementById('session-status-badge');
  badge.textContent = currentSession.session_status;
  badge.className = `meeting-status meeting-status--${currentSession.session_status}`;

  // Build the in-call toolbar for this user's role (host gets Session logs)
  buildToolbar(amHost);

  // Pre-join chrome: toolbar + self indicator hidden, Join button shown, drawer closed
  document.getElementById('meeting-toolbar').style.display = 'none';
  document.getElementById('video-self').style.display = 'none';
  document.getElementById('session-actions').style.display = 'flex';
  closeDrawer();
  stopMeetingTimer();

  // Session info (visible to everyone, including clients)
  document.getElementById('info-meeting-id').textContent = currentSession.meeting_code || `#${currentSession.id}`;
  document.getElementById('info-psychologist').textContent = currentSession.psychologist_name || '—';
  document.getElementById('info-client').textContent = currentSession.client_name || 'Not assigned';
  document.getElementById('info-started').textContent = currentSession.started_at ? formatDateTime(currentSession.started_at) : 'Not started';
  document.getElementById('info-recording').textContent = currentSession.recording_enabled
    ? 'Active (Approved)'
    : currentSession.recording_requested ? 'Requested'
    : currentSession.recording_response === 0 ? 'Rejected' : 'Off';

  // Host-only controls live inside the Session info drawer
  document.getElementById('psych-controls').style.display =
    (amHost && currentSession.session_status !== 'ended') ? 'flex' : 'none';

  // Session logs content (HOST only — button is also host-only)
  if (amHost) loadSessionLogs(sessionId);

  // Waiting room section lives inside the People drawer (HOST only)
  document.getElementById('people-waiting').style.display = amHost ? 'block' : 'none';
  renderWaitingRoom(currentSession.participants || []);

  // Participants roster (with role labels) — visible before joining too
  renderParticipantsPanel(currentSession.participants || []);

  // Recording banner + toolbar indicator
  updateRecordingBanner();

  // Secure session emoji fingerprint
  updateSecurityIndicator();

  resetChat();

  // Disable join if ended
  const joinBtn = document.getElementById('btn-join');
  joinBtn.disabled = false;
  if (currentSession.session_status === 'ended' || currentSession.session_status === 'cancelled') {
    joinBtn.disabled = true;
    joinBtn.innerHTML = 'Session Ended';
  }

  lucide.createIcons();

  // Start real-time polling (waiting room, recording requests, status, chat)
  startPolling();
  return true;
}

// ===== IN-CALL TOOLBAR =====
let currentDrawer = null;

function buildToolbar(amHost) {
  const buttons = [
    { id: 'tb-camera', icon: 'video', label: 'Camera', onclick: 'toggleVideo()' },
    { id: 'tb-mic', icon: 'mic', label: 'Mic', onclick: 'toggleAudio()' },
    { sep: true },
    { id: 'tb-chat', icon: 'message-square', label: 'Chat', onclick: "openDrawer('chat')" },
    { id: 'tb-people', icon: 'users', label: 'People', onclick: "openDrawer('people')" },
    { id: 'tb-info', icon: 'info', label: 'Session info', onclick: "openDrawer('info')" },
  ];
  if (amHost) buttons.push({ id: 'tb-logs', icon: 'scroll-text', label: 'Session logs', onclick: "openDrawer('logs')" });
  buttons.push({ sep: true });
  // Everyone can leave the room (room stays active for others). Only the HOST
  // gets "End Call for All", which terminates the session for every participant.
  buttons.push({ id: 'tb-leave', icon: 'log-out', label: 'Leave Room', onclick: 'leaveSession()', danger: true });
  if (amHost) buttons.push({ id: 'tb-end', icon: 'phone-off', label: 'End Call for All', onclick: 'endSessionAction()', danger: true });

  document.getElementById('toolbar-controls').innerHTML = buttons.map(b => {
    if (b.sep) return '<span class="mt-sep"></span>';
    return `<button class="mt-btn ${b.danger ? 'mt-btn--leave' : ''}" id="${b.id}" onclick="${b.onclick}">
        <span class="mt-btn__icon"><i data-lucide="${b.icon}"></i></span>
        <span class="mt-btn__label">${b.label}</span>
      </button>`;
  }).join('');
  lucide.createIcons();
}

function openDrawer(name) {
  const drawer = document.getElementById('meeting-drawer');
  const stage = document.getElementById('session-stage');
  const panels = { people: 'people-drawer', chat: 'chat-drawer', info: 'info-drawer', logs: 'logs-drawer' };
  const btnMap = { people: 'tb-people', chat: 'tb-chat', info: 'tb-info', logs: 'tb-logs' };

  // Toggle off if the same panel is already open
  if (stage.classList.contains('drawer-open') && currentDrawer === name) { closeDrawer(); return; }

  currentDrawer = name;
  stage.classList.add('drawer-open');
  drawer.setAttribute('aria-hidden', 'false');
  Object.values(panels).forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  const panelEl = document.getElementById(panels[name]);
  if (panelEl) panelEl.style.display = 'flex';

  // Bound the drawer to the video container's height so inner lists
  // (e.g. session logs) get their own scrollbar instead of stretching the page.
  syncDrawerHeight();

  document.querySelectorAll('.mt-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(btnMap[name]);
  if (btn) btn.classList.add('active');

  if (name === 'chat') {
    const box = document.getElementById('chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
    setTimeout(() => { const ci = document.getElementById('chat-input'); if (ci) ci.focus(); }, 60);
  }
  // Session logs: load the CURRENT log immediately when the panel is opened
  // (real-time poll then keeps it fresh while it stays open).
  if (name === 'logs' && currentSession) loadSessionLogs(currentSession.id);
  lucide.createIcons();
}

function closeDrawer() {
  const drawer = document.getElementById('meeting-drawer');
  const stage = document.getElementById('session-stage');
  if (stage) stage.classList.remove('drawer-open');
  if (drawer) drawer.setAttribute('aria-hidden', 'true');
  document.querySelectorAll('.mt-btn').forEach(b => b.classList.remove('active'));
  currentDrawer = null;
}

// Size the drawer to match the video container so its panels (esp. the
// session logs) scroll internally rather than stretching the layout.
function syncDrawerHeight() {
  const vc = document.getElementById('video-container');
  const drawer = document.getElementById('meeting-drawer');
  if (!vc || !drawer) return;
  const h = vc.offsetHeight;
  if (h > 0) {
    drawer.style.height = h + 'px';
    drawer.style.alignSelf = 'flex-start';
  } else {
    drawer.style.height = '';
    drawer.style.alignSelf = '';
  }
}
window.addEventListener('resize', () => {
  if (document.getElementById('session-stage')?.classList.contains('drawer-open')) syncDrawerHeight();
});

function filterPeople(q) {
  const term = (q || '').trim().toLowerCase();
  document.querySelectorAll('#participants-list .participant-item, #waiting-room-list .waiting-item').forEach(row => {
    const name = (row.getAttribute('data-name') || '').toLowerCase();
    row.style.display = (!term || name.includes(term)) ? '' : 'none';
  });
}

// ===== MEETING TIMER =====
// Synchronized across all participants: elapsed time is computed from the
// meeting's server-side start timestamp (currentSession.started_at, set when
// the host first activates the session), NOT from each participant's join
// time. Late joiners therefore see the true current duration.
let meetingTimerInt = null, meetingTimerStart = 0;

// Epoch (ms) of the meeting's start; falls back to local start time only if
// the server hasn't recorded started_at yet.
function sessionStartEpoch() {
  if (currentSession && currentSession.started_at) {
    const t = new Date(currentSession.started_at).getTime();
    if (!isNaN(t)) return t;
  }
  return meetingTimerStart || Date.now();
}

function startMeetingTimer() {
  meetingTimerStart = Date.now(); // fallback until started_at is known
  updateMeetingTimer();
  if (meetingTimerInt) clearInterval(meetingTimerInt);
  meetingTimerInt = setInterval(updateMeetingTimer, 1000);
}
function updateMeetingTimer() {
  const s = Math.max(0, Math.floor((Date.now() - sessionStartEpoch()) / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = n => String(n).padStart(2, '0');
  const txt = (hh > 0 ? pad(hh) + ':' : '') + pad(mm) + ':' + pad(ss);
  const el = document.getElementById('timer-text');
  if (el) el.textContent = txt;
}
function stopMeetingTimer() {
  if (meetingTimerInt) { clearInterval(meetingTimerInt); meetingTimerInt = null; }
  const el = document.getElementById('timer-text');
  if (el) el.textContent = '00:00';
}

// Swap a lucide icon inside a wrapper element
function setIcon(wrap, name) {
  if (!wrap) return;
  wrap.innerHTML = `<i data-lucide="${name}"></i>`;
  lucide.createIcons();
}

function updateSelfIndicator() {
  const wrap = document.getElementById('video-self');
  if (!wrap || !twilioRoom) return;
  let muted = false;
  twilioRoom.localParticipant.audioTracks.forEach(pub => { muted = !pub.track.isEnabled; });
  document.getElementById('self-label').textContent = muted ? 'You · muted' : 'You';
  wrap.classList.toggle('video-self--muted', muted);
  setIcon(document.getElementById('self-mic-icon-wrap'), muted ? 'mic-off' : 'mic');
}

function updateRecordingBanner() {
  const banner = document.getElementById('recording-banner');
  if (!currentSession) return;

  // Recording is ACTIVE only after the client approved (recording_enabled
  // is now set true only on approval). A pending host request awaiting the
  // client's decision is tracked by recording_requested.
  const recActive = currentSession.recording_enabled && currentSession.recording_response === 1;
  const recPending = !!currentSession.recording_requested &&
    (currentSession.recording_response === null || currentSession.recording_response === undefined);
  const recRejected = !recActive && currentSession.recording_response === 0;

  // Toolbar "REC" indicator sits beside the timer while actively recording
  const recPill = document.getElementById('toolbar-rec');
  if (recPill) recPill.style.display = recActive ? 'inline-flex' : 'none';

  // Host record button: show Stop while a request is pending OR actively
  // recording (Stop also cancels a pending request); otherwise show Start.
  const startBtn = document.getElementById('btn-start-recording');
  const stopBtn = document.getElementById('btn-stop-recording');
  if (startBtn && stopBtn) {
    if (recActive || recPending) {
      startBtn.style.display = 'none'; stopBtn.style.display = 'flex';
    } else {
      startBtn.style.display = 'flex'; stopBtn.style.display = 'none';
    }
  }

  const consentBtns = document.getElementById('recording-consent-btns');
  if (recActive) {
    // While actively recording, the toolbar pill carries the cue — hide the banner
    banner.style.display = 'none';
    banner.classList.add('recording-banner--active');
    consentBtns.style.display = 'none';
  } else if (recPending) {
    banner.style.display = 'flex';
    document.getElementById('recording-status-text').textContent = 'Recording requested — awaiting client decision';
    // Inline allow/deny available to the client as a fallback to the popup
    consentBtns.style.display = (user.id === currentSession.client_id) ? 'flex' : 'none';
    banner.classList.remove('recording-banner--active');
  } else if (recRejected) {
    banner.style.display = 'flex';
    document.getElementById('recording-status-text').textContent = 'Recording was rejected by the client';
    consentBtns.style.display = 'none';
    banner.classList.remove('recording-banner--active');
  } else {
    banner.style.display = 'none';
    consentBtns.style.display = 'none';
    banner.classList.remove('recording-banner--active');
  }
}

// ===== EMOJI SECURE SESSION INDICATOR =====
// Renders the deterministic 4-emoji fingerprint supplied by the server. The
// same encrypted session yields the same emojis for both participants; a new
// session yields a new sequence. The raw key is never received here.
function updateSecurityIndicator() {
  const el = document.getElementById('secure-emojis');
  if (!el || !currentSession) return;
  const em = currentSession.security_emojis;
  el.textContent = (Array.isArray(em) && em.length) ? em.join(' ') : '····';
}

// ── CAPTCHA gate for opening a meeting ──────────────────────────────
// Email OTP is handled at page load (gating access to the module). A CAPTCHA
// is required the moment the user clicks "Join" on a meeting card — BEFORE the
// teleconference session UI (with its "Join Session" button) is shown. Called
// from openSession(), which both the card "Join" button and the notification
// deep-link route through. Verified once per session, then reused; cleared on
// logout. Returns true if the user may proceed.
async function ensureJoinCaptcha() {
  if (BPSCaptcha.isMeetingsVerified()) return true;
  const passed = await BPSCaptcha.verify('teleconference_join');
  if (passed) {
    BPSCaptcha.setMeetingsVerified();
    return true;
  }
  BPSToast.error('A security check is required before joining a meeting.', { title: 'Verification Required' });
  return false;
}

// ===== JOIN (waiting room, no password) =====
async function joinSession(retried) {
  if (!currentSession) return;
  if (currentSession.session_status === 'ended' || currentSession.session_status === 'cancelled') {
    BPSToast.error('This session has already ended.', { title: 'Session Ended' });
    return;
  }

  // CAPTCHA was already required when the user opened this session (openSession).
  // Keep the page-load OTP session fresh on each join attempt.
  BPSTeleconfOtp.touchSession(currentSession && currentSession.id);

  const btn = document.getElementById('btn-join');
  btn.disabled = true;
  btn.textContent = 'Joining…';

  try {
    const data = await apiFetch(`/teleconference/${currentSession.id}/join`, { method: 'POST', body: JSON.stringify({ connectionToken: currentConnectionToken || undefined, reconnectToken: loadReconnectToken(currentSession.id) || undefined }) });

    if (!data.success) {
      btn.disabled = false; btn.textContent = 'Join Session';
      // OTP clearance expired (e.g. after the grace window) — re-verify the
      // email OTP, then retry the join once. This is NOT a generic error.
      if (data.code === 'NEEDS_OTP' && !retried) {
        const ok = await BPSTeleconfOtp.verify((BPSSession.getUser() || {}).email || '');
        if (ok) return joinSession(true);
        return;
      }
      // Specific, understandable titles instead of a catch-all "Join Error".
      const title = data.code === 'BOUND_TO_OTHER_DEVICE' ? 'Open on Another Device'
                  : data.code === 'ALREADY_IN_ROOM'       ? 'Already in the Room'
                  : data.code === 'NEEDS_OTP'             ? 'Verification Needed'
                  : 'Unable to Join';
      BPSToast.error(data.message || 'Failed to join session.', { title });
      return;
    }

    if (data.waiting) {
      // Placed in the waiting room — wait for the host to admit
      awaitingAdmission = true;
      showWaitingOverlay();
      BPSToast.info('Waiting for the host to admit you.', { title: 'Waiting Room' });
      btn.disabled = true; btn.textContent = 'Waiting for host…';
      return;
    }

    // Admitted (or host) — connect to the room
    await connectToRoom(data.data);
  } catch (err) {
    console.error('Join failed:', err);
    BPSToast.error('Could not reach the server. Please check your connection and try again.', { title: 'Connection Problem' });
    btn.disabled = false; btn.textContent = 'Join Session';
  }
}

function showWaitingOverlay() {
  const grid = document.getElementById('video-grid');
  grid.innerHTML = `
    <div class="video-placeholder">
      <i data-lucide="clock" style="width:56px;height:56px;"></i>
      <p><strong>You're in the waiting room</strong></p>
      <p style="font-size:12px;margin-top:6px;opacity:0.7;">Please wait — the host will admit you shortly.</p>
    </div>`;
  lucide.createIcons();
}

async function connectToRoom(joinData, opts = {}) {
  const btn = document.getElementById('btn-join');
  btn.textContent = 'Connecting...';
  awaitingAdmission = false;

  try {
    const { token: videoToken, roomName, identity } = joinData;

    // Remember the per-join seat token so the server knows this device owns the
    // seat (used by the heartbeat and on any reconnect).
    currentConnectionToken = joinData.connectionToken || null;
    intentionalLeave = false;
    // Persist the durable reconnect token so a refresh/crash can reclaim the seat.
    if (currentSession && joinData.reconnectToken) {
      saveReconnectToken(currentSession.id, joinData.reconnectToken);
    }

    // Adopt the server's meeting start timestamp so the timer is synchronized
    // (this participant's join may be what activated the session).
    if (joinData.session) {
      if (joinData.session.started_at) currentSession.started_at = joinData.session.started_at;
      if (joinData.session.security_emojis) currentSession.security_emojis = joinData.session.security_emojis;
    }

    // Connect to Twilio Video
    twilioRoom = await Twilio.Video.connect(videoToken, {
      name: roomName,
      audio: true,
      video: { width: 640, height: 480 },
    });

    // Enter in-call mode: show toolbar + self indicator, hide Join button
    document.getElementById('meeting-toolbar').style.display = 'flex';
    document.getElementById('video-self').style.display = 'inline-flex';
    document.getElementById('session-actions').style.display = 'none';
    startMeetingTimer();

    // Render local tracks
    const videoGrid = document.getElementById('video-grid');
    videoGrid.innerHTML = '';
    mediaState = {};

    const localDiv = createParticipantDiv(identity + ' (You)', true);
    videoGrid.appendChild(localDiv);

    twilioRoom.localParticipant.tracks.forEach(pub => {
      if (pub.track) {
        localDiv.querySelector('.video-track').appendChild(pub.track.attach());
        localTracks.push(pub.track);
      }
    });

    // Default join state: camera OFF and microphone MUTED.
    twilioRoom.localParticipant.audioTracks.forEach(pub => { try { pub.track.disable(); } catch (e) {} });
    twilioRoom.localParticipant.videoTracks.forEach(pub => { try { pub.track.disable(); } catch (e) {} });
    mediaState[identity] = { cam: false, mic: false };
    localDiv.classList.add('video-participant--camoff');

    // Voice-activity detection for the local mic (starts muted → not speaking).
    speakingState = {};
    localMicEnabled = false;
    twilioRoom.localParticipant.audioTracks.forEach(pub => {
      if (pub.track && pub.track.mediaStreamTrack) {
        vadRegister(identity, pub.track.mediaStreamTrack, true);
      }
    });

    // Reflect the default (off) state on the toolbar buttons
    const camBtn = document.getElementById('tb-camera');
    if (camBtn) { camBtn.classList.add('mt-btn--off'); setIcon(camBtn.querySelector('.mt-btn__icon'), 'video-off'); }
    const micBtn = document.getElementById('tb-mic');
    if (micBtn) { micBtn.classList.add('mt-btn--off'); setIcon(micBtn.querySelector('.mt-btn__icon'), 'mic-off'); }

    // Handle remote participants
    twilioRoom.participants.forEach(p => handleParticipantConnected(p));
    twilioRoom.on('participantConnected', handleParticipantConnected);
    twilioRoom.on('participantDisconnected', handleParticipantDisconnected);

    // Keep our live-call seat alive; stop heartbeating once disconnected. If the
    // disconnect was NOT an intentional leave (network drop, crash), try to
    // silently reclaim the seat with the durable reconnect token.
    const sid = currentSession && currentSession.id;
    startSeatHeartbeat();
    twilioRoom.on('disconnected', () => {
      stopSeatHeartbeat();
      // The call dropped before reaching the "stable" mark — cancel the pending
      // budget reset so repeated churn actually counts toward the retry cap.
      if (stabilityTimer) { clearTimeout(stabilityTimer); stabilityTimer = null; }
      // Don't auto-reconnect if we left on purpose or the host ended the call.
      if (!intentionalLeave && !sessionWasEnded && sid) attemptReconnect(sid);
    });

    // Update participants list + adapt the grid
    renderParticipantsPanel(currentSession && currentSession.participants || []);
    updateVideoGridLayout();

    // Chat becomes available now that the user has joined
    resetChat();
    loadChatMessages();

    // Reflect initial mic state in the toolbar + self indicator
    updateSelfIndicator();

    // Enter MS Teams-style meeting mode (left nav rail)
    document.body.classList.add('meeting-mode');

    // Update session status
    const badge = document.getElementById('session-status-badge');
    badge.textContent = 'active';
    badge.className = 'meeting-status meeting-status--active';

    lucide.createIcons();
    // Exactly ONE toast per (re)connect. Reconnects show the "Reconnected"
    // wording; a first/normal join shows "Session Active".
    if (opts.isReconnect) {
      BPSToast.success('Reconnected to your session.', { title: 'Reconnected' });
    } else {
      BPSToast.success('Connected to session successfully!', { title: 'Session Active' });
    }
    // Arm the stability timer: staying connected long enough refills the retry
    // budget so an unrelated later drop still gets a full set of attempts.
    markConnectedStable();
  } catch (err) {
    console.error('Failed to join video:', err);
    // Report the ACTUAL cause instead of always blaming camera/mic. The video
    // SDK failing to load, a denied permission, a missing device, and a bad
    // Twilio token all land here but need different fixes.
    let msg = 'Failed to connect to video. Please try again.';
    const name = err && err.name;
    if (typeof Twilio === 'undefined' || /is not defined|reading 'Video'|undefined/.test((err && err.message) || '')) {
      msg = 'The video library failed to load. Check your internet connection and refresh the page.';
    } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      msg = 'Camera/microphone access was blocked. Allow camera & mic permissions in your browser, then try again.';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      msg = 'No camera or microphone was found. Connect a device and try again.';
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      msg = 'Your camera/microphone is already in use by another app. Close it and try again.';
    } else if (err && typeof err.code === 'number') {
      msg = `Could not join the video room (error ${err.code}). Please try again or contact support.`;
    }
    BPSToast.error(msg, { title: 'Connection Failed' });
    btn.disabled = false;
    btn.textContent = 'Join Session';
  }
}

function createParticipantDiv(name, isLocal = false) {
  const div = document.createElement('div');
  div.className = `video-participant ${isLocal ? 'video-participant--local' : ''}`;
  const cleanName = (name || '').replace(/ \(You\)$/, '');
  div.dataset.identity = cleanName;
  const initial = escHtml(((cleanName || '?').trim().charAt(0) || '?').toUpperCase());
  div.innerHTML = `
    <div class="video-track"></div>
    <div class="video-participant__avatar" aria-hidden="true"><span>${initial}</span></div>
    <div class="video-participant__name">${escHtml(name)}</div>
  `;
  return div;
}

function handleParticipantConnected(participant) {
  const videoGrid = document.getElementById('video-grid');
  const div = createParticipantDiv(participant.identity);
  div.id = `participant-${participant.sid}`;
  videoGrid.appendChild(div);

  // Read current camera/mic state from the participant's track publications.
  function syncRemoteMedia() {
    let cam = false, mic = false;
    participant.tracks.forEach(pub => {
      const en = (pub.isTrackEnabled !== undefined) ? pub.isTrackEnabled : (pub.track ? pub.track.isEnabled : false);
      if (pub.kind === 'video') cam = en;
      if (pub.kind === 'audio') mic = en;
    });
    mediaState[participant.identity] = { cam, mic };
    div.classList.toggle('video-participant--camoff', !cam);
    if (currentSession) renderParticipantsPanel(currentSession.participants || []);
  }

  participant.tracks.forEach(pub => {
    if (pub.isSubscribed && pub.track) {
      div.querySelector('.video-track').appendChild(pub.track.attach());
      if (pub.track.kind === 'audio' && pub.track.mediaStreamTrack) {
        vadRegister(participant.identity, pub.track.mediaStreamTrack, false);
      }
    }
  });
  participant.on('trackSubscribed', track => {
    div.querySelector('.video-track').appendChild(track.attach());
    if (track.kind === 'audio' && track.mediaStreamTrack) {
      vadRegister(participant.identity, track.mediaStreamTrack, false);
    }
    syncRemoteMedia();
  });
  participant.on('trackUnsubscribed', track => {
    track.detach().forEach(el => el.remove());
    if (track.kind === 'audio') vadUnregister(participant.identity);
    syncRemoteMedia();
  });
  participant.on('trackEnabled', syncRemoteMedia);
  participant.on('trackDisabled', syncRemoteMedia);

  syncRemoteMedia();
  updateVideoGridLayout();
}

function handleParticipantDisconnected(participant) {
  const el = document.getElementById(`participant-${participant.sid}`);
  if (el) el.remove();
  delete mediaState[participant.identity];
  vadUnregister(participant.identity);
  renderParticipantsPanel(currentSession && currentSession.participants || []);
  updateVideoGridLayout();
}

// ===== VOICE ACTIVITY DETECTION =====
// Real-time speaking detection for every participant (local + remote). When a
// participant's mic input rises above a threshold, a green border is shown on
// their video tile and People-panel card; it clears when they go quiet.
let audioCtx = null;
const vadMap = {};            // identity -> { analyser, data, source, speaking, lastAbove, isLocal }
let vadRafId = null;
let localMicEnabled = false;  // local mic starts muted; only flag speaking when on
const VAD_ON = 0.045;         // RMS level to count as "speaking"
const VAD_OFF = 0.030;        // drop below this (for VAD_HOLD ms) to stop
const VAD_HOLD = 280;         // ms to keep the border after going quiet (anti-flicker)

function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) {} }
  return audioCtx;
}

function vadRegister(identity, mediaStreamTrack, isLocal) {
  try {
    if (!identity || !mediaStreamTrack) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    vadUnregister(identity); // replace any previous entry
    const source = ctx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    vadMap[identity] = {
      analyser, source, isLocal: !!isLocal,
      data: new Uint8Array(analyser.frequencyBinCount),
      speaking: false, lastAbove: 0,
    };
    if (!vadRafId) vadRafId = requestAnimationFrame(vadTick);
  } catch (e) { /* VAD is best-effort */ }
}

function vadUnregister(identity) {
  const e = vadMap[identity];
  if (!e) return;
  try { e.source.disconnect(); } catch (_) {}
  try { e.analyser.disconnect(); } catch (_) {}
  setSpeaking(identity, false);
  delete vadMap[identity];
}

function vadTeardownAll() {
  Object.keys(vadMap).forEach(vadUnregister);
  if (vadRafId) { cancelAnimationFrame(vadRafId); vadRafId = null; }
  if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
}

function vadTick() {
  const now = performance.now();
  Object.keys(vadMap).forEach(identity => {
    const e = vadMap[identity];
    if (!e) return;
    e.analyser.getByteTimeDomainData(e.data);
    // RMS of the waveform around the 128 midpoint, normalised to ~0..1.
    let sum = 0;
    for (let i = 0; i < e.data.length; i++) {
      const v = (e.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / e.data.length);

    // The local mic may still feed audio while muted, so only treat the local
    // participant as speaking when their mic is actually enabled.
    const gated = e.isLocal && !localMicEnabled;

    let speaking = e.speaking;
    if (!gated && rms >= VAD_ON) { speaking = true; e.lastAbove = now; }
    else if (rms >= VAD_OFF && !gated) { e.lastAbove = now; }
    else if (now - e.lastAbove > VAD_HOLD || gated) { speaking = false; }

    if (speaking !== e.speaking) {
      e.speaking = speaking;
      setSpeaking(identity, speaking);
    }
  });
  vadRafId = Object.keys(vadMap).length ? requestAnimationFrame(vadTick) : null;
}

// Toggle the green "speaking" indicator on both the video tile and the
// People-panel card for the given identity (= the participant's full name).
function setSpeaking(identity, speaking) {
  speakingState[identity] = speaking;
  const tile = document.querySelector(`.video-participant[data-identity="${cssEsc(identity)}"]`);
  if (tile) tile.classList.toggle('video-participant--speaking', speaking);
  document.querySelectorAll(`.participant-item[data-name="${cssEsc(identity)}"]`).forEach(el => {
    el.classList.toggle('participant-item--speaking', speaking);
  });
}

// Re-apply speaking borders to People cards after they are re-rendered.
function reapplySpeaking() {
  Object.keys(speakingState).forEach(identity => {
    if (speakingState[identity]) {
      document.querySelectorAll(`.participant-item[data-name="${cssEsc(identity)}"]`).forEach(el => {
        el.classList.add('participant-item--speaking');
      });
    }
  });
}

function cssEsc(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, '\\$&');
}

// Reusable: update the grid layout whenever the participant count changes.
// The CSS keys off [data-count] to produce the Discord/Meet/Teams arrangements.
function updateVideoGridLayout() {
  const grid = document.getElementById('video-grid');
  if (!grid) return;
  const tiles = grid.querySelectorAll('.video-participant').length;
  grid.setAttribute('data-count', String(Math.min(tiles, 6)));
  grid.classList.toggle('in-call', tiles > 0);
  // keep an open drawer matched to the (now possibly taller) video container
  const stage = document.getElementById('session-stage');
  if (stage && stage.classList.contains('drawer-open')) syncDrawerHeight();
}

function roleLabel(r) {
  return r === 'host' ? 'Host' : r === 'client' ? 'Client' : 'Staff';
}

// Camera/mic icons for a participant, read from mediaState (keyed by identity = full name).
function mediaIcons(identity) {
  const st = mediaState[identity] || { cam: false, mic: false };
  return `<span class="participant-media">
    <span class="pm-icon ${st.cam ? 'pm-on' : 'pm-off'}" title="Camera ${st.cam ? 'on' : 'off'}"><i data-lucide="${st.cam ? 'video' : 'video-off'}"></i></span>
    <span class="pm-icon ${st.mic ? 'pm-on' : 'pm-off'}" title="Microphone ${st.mic ? 'on' : 'off'}"><i data-lucide="${st.mic ? 'mic' : 'mic-off'}"></i></span>
  </span>`;
}

// "In this meeting" roster — ONLY participants who have actually joined the call
// (joined_at set). Camera/mic state is shown via icons; the host gets a Remove control.
function renderParticipantsPanel(participants) {
  const list = document.getElementById('participants-list');
  if (!list) return;
  const amHost = currentSession && currentSession.am_i_host;
  const inMeeting = (participants || []).filter(p => p.joined_at && p.admit_status === 'admitted');

  const countEl = document.getElementById('inmeeting-count');
  if (countEl) countEl.textContent = inMeeting.length;

  if (!inMeeting.length) {
    list.innerHTML = '<div class="participant-placeholder">No one has joined yet</div>';
  } else {
    list.innerHTML = inMeeting.map(p => {
      // display_name is the canonical label (staff → "FirstName (Role)", never
      // staff_id) and matches the Twilio identity, so mediaIcons keys line up.
      const dn = p.display_name || p.full_name || 'Participant';
      const isSelf = p.user_id === user.id;
      const you = isSelf ? ' (You)' : '';
      const canRemove = amHost && !isSelf && p.participant_role !== 'host';
      const safeName = escHtml(dn.replace(/'/g, "\\'"));
      const removeBtn = canRemove
        ? `<button class="participant-remove" title="Remove from meeting" onclick="removeParticipant(${p.user_id}, '${safeName}')"><i data-lucide="user-x"></i></button>`
        : '';
      return `<div class="participant-item" data-name="${escHtml(dn)}">
        <div class="participant-avatar">${(dn || '?')[0]}</div>
        <div class="participant-meta">
          <span class="participant-name">${escHtml(dn)}${you}</span>
          <span class="role-badge role-badge--${p.participant_role}">${roleLabel(p.participant_role)}</span>
        </div>
        ${mediaIcons(dn)}
        ${removeBtn}
      </div>`;
    }).join('');
  }

  renderInvited(participants);
  if (window.lucide) lucide.createIcons();
  reapplySpeaking();
  const q = document.getElementById('people-search-input');
  if (q && q.value) filterPeople(q.value);
}

// "Not in the Meeting" — provisioned participants who have NOT yet attempted
// to join (admit_status = 'invited'). Once they try to enter they move to the
// Waiting Room (admit_status = 'waiting'); once admitted + joined they appear
// under "In this meeting".
function renderInvited(participants) {
  const sec = document.getElementById('people-invited');
  const list = document.getElementById('invited-list');
  if (!sec || !list) return;
  const invited = (participants || []).filter(p =>
    p.admit_status === 'invited' && !p.joined_at
  );

  const countEl = document.getElementById('invited-count');
  if (countEl) countEl.textContent = invited.length;

  if (!invited.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  list.innerHTML = invited.map(p => {
    const dn = p.display_name || p.full_name || 'Participant';
    const you = p.user_id === user.id ? ' (You)' : '';
    return `<div class="participant-item participant-item--invited" data-name="${escHtml(dn)}">
      <div class="participant-avatar participant-avatar--muted">${(dn || '?')[0]}</div>
      <div class="participant-meta">
        <span class="participant-name">${escHtml(dn)}${you}</span>
        <span class="role-badge role-badge--${p.participant_role}">${roleLabel(p.participant_role)}</span>
      </div>
      <span class="participant-invited-tag">Not joined</span>
    </div>`;
  }).join('');
}

// Host removes a participant from the meeting.
function removeParticipant(userId, name) {
  if (!currentSession) return;
  tcOpenConfirm('Remove Participant', `Remove ${name || 'this participant'} from the meeting?`, async () => {
    try {
      const data = await apiFetch(`/teleconference/${currentSession.id}/remove`, {
        method: 'PUT', body: JSON.stringify({ user_id: userId }),
      });
      if (data.success) {
        BPSToast.success(`${name || 'Participant'} was removed from the meeting.`, { title: 'Participant Removed' });
        pollLoop();
      } else {
        BPSToast.error(data.message || 'Failed to remove participant.', { title: 'Error' });
      }
    } catch (e) {
      BPSToast.error('Failed to remove participant.', { title: 'Error' });
    }
  });
}

// Update the local user's media state and refresh the roster icons.
function setSelfMedia(patch) {
  const id = (user && user.full_name) || 'You';
  mediaState[id] = Object.assign({ cam: false, mic: false }, mediaState[id], patch);
  if (currentSession) renderParticipantsPanel(currentSession.participants || []);
}

function toggleAudio() {
  if (!twilioRoom) return;
  let enabled = true;
  twilioRoom.localParticipant.audioTracks.forEach(pub => {
    if (pub.track.isEnabled) { pub.track.disable(); enabled = false; } else { pub.track.enable(); enabled = true; }
  });
  const btn = document.getElementById('tb-mic');
  if (btn) {
    btn.classList.toggle('mt-btn--off', !enabled);
    setIcon(btn.querySelector('.mt-btn__icon'), enabled ? 'mic' : 'mic-off');
  }
  localMicEnabled = enabled;
  if (!enabled) {
    // Going muted should immediately clear the local speaking border.
    const me = twilioRoom && twilioRoom.localParticipant ? twilioRoom.localParticipant.identity : null;
    if (me) setSpeaking(me, false);
  }
  setSelfMedia({ mic: enabled });
  updateSelfIndicator();
}

function toggleVideo() {
  if (!twilioRoom) return;
  let enabled = true;
  twilioRoom.localParticipant.videoTracks.forEach(pub => {
    if (pub.track.isEnabled) { pub.track.disable(); enabled = false; } else { pub.track.enable(); enabled = true; }
  });
  const btn = document.getElementById('tb-camera');
  if (btn) {
    btn.classList.toggle('mt-btn--off', !enabled);
    setIcon(btn.querySelector('.mt-btn__icon'), enabled ? 'video' : 'video-off');
  }
  const localDiv = document.querySelector('.video-participant--local');
  if (localDiv) localDiv.classList.toggle('video-participant--camoff', !enabled);
  setSelfMedia({ cam: enabled });
}

function leaveSession() {
  // Mark this as an intentional leave so the disconnect handler does NOT try to
  // auto-reconnect. We deliberately KEEP the durable reconnect token: the seat
  // stays bound to THIS device so only it can rejoin — a second device on the
  // same account cannot take the seat after we leave. The token is dropped only
  // when the session ends or the host removes us.
  intentionalLeave = true;
  stopSeatHeartbeat();
  resetReconnectState(); // cancel any pending auto-reconnect + its toasts
  // Tell the backend we left so we drop out of the roster (keeps us admitted
  // so a rejoin reinstates us as an active participant automatically).
  if (currentSession && twilioRoom) {
    try {
      apiFetch(`/teleconference/${currentSession.id}/leave`, { method: 'POST' }).catch(() => {});
    } catch (e) { /* best-effort */ }
  }
  stopPolling();
  stopMeetingTimer();
  closeDrawer();
  awaitingAdmission = false;
  recordingPromptOpen = false;
  document.getElementById('recording-consent-modal').style.display = 'none';

  vadTeardownAll();
  speakingState = {};

  if (twilioRoom) {
    twilioRoom.disconnect();
    twilioRoom = null;
  }
  localTracks.forEach(t => { t.stop(); t.detach().forEach(el => el.remove()); });
  localTracks = [];
  mediaState = {};

  currentSession = null;
  lastMessageId = 0;
  document.getElementById('session-detail-view').style.display = 'none';
  // Both roles return to the calming dashboard view.
  const _cdv = document.getElementById('client-dashboard-view');
  if (_cdv) _cdv.style.display = 'block';
  document.getElementById('meeting-toolbar').style.display = 'none';
  document.getElementById('video-self').style.display = 'none';
  document.getElementById('session-actions').style.display = 'flex';
  document.getElementById('people-waiting').style.display = 'none';
  const invSec = document.getElementById('people-invited');
  if (invSec) invSec.style.display = 'none';
  const recPill = document.getElementById('toolbar-rec');
  if (recPill) recPill.style.display = 'none';
  const partList = document.getElementById('participants-list');
  if (partList) partList.innerHTML = '<div class="participant-placeholder">No participants yet</div>';
  const chatBox = document.getElementById('chat-messages');
  if (chatBox) chatBox.innerHTML = '<div class="chat-empty">No messages yet</div>';
  document.body.classList.remove('meeting-mode');
  const grid0 = document.getElementById('video-grid');
  grid0.classList.remove('in-call');
  grid0.removeAttribute('data-count');
  grid0.innerHTML = `
    <div class="video-placeholder">
      <i data-lucide="video" style="width:60px;height:60px;"></i>
      <p>Click <strong>Join Session</strong> to start the video consultation</p>
    </div>`;
  const jb = document.getElementById('btn-join');
  jb.disabled = false;
  jb.innerHTML = '<i data-lucide="video" style="width:18px;height:18px;margin-right:8px;"></i> Join Session';
  lucide.createIcons();

  if (isStaffUser) loadStaffDashboard();
  else loadClientDashboard();
}

// ===== RECORDING =====
async function requestRecording() {
  if (!currentSession) return;
  const data = await apiFetch(`/teleconference/${currentSession.id}/start-recording`, { method: 'PUT' });
  if (data.success) {
    // Request only — recording does NOT start until the client approves.
    currentSession.recording_requested = true;
    currentSession.recording_enabled = false;
    currentSession.recording_response = null;
    currentSession.recording_consent_given = false;
    updateRecordingBanner();
    BPSToast.info('Recording requested. Waiting for client decision.', { title: 'Recording' });
  } else {
    BPSToast.error(data.message || 'Failed to start recording.', { title: 'Recording Error' });
  }
}

async function giveRecordingConsent(consent) {
  if (!currentSession) return;
  const data = await apiFetch(`/teleconference/${currentSession.id}/consent-recording`, {
    method: 'PUT',
    body: JSON.stringify({ consent }),
  });
  if (data.success) {
    // Recording actually starts ONLY when the client approves.
    currentSession.recording_response = consent ? 1 : 0;
    currentSession.recording_consent_given = !!consent;
    currentSession.recording_enabled = !!consent;
    currentSession.recording_requested = false;
    recordingResponded = true;
    updateRecordingBanner();
    BPSToast.success(consent ? 'Recording approved.' : 'Recording rejected.', { title: consent ? 'Recording Approved' : 'Recording Rejected' });
  } else {
    BPSToast.error(data.message || 'Failed to record your decision.', { title: 'Error' });
  }
}

// Real-time popup response (client)
async function respondRecording(approve) {
  document.getElementById('recording-consent-modal').style.display = 'none';
  recordingPromptOpen = false;
  await giveRecordingConsent(!!approve);
}

// ===== REAL-TIME POLLING (waiting room + recording requests + status) =====
function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollLoop, 4000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollLoop() {
  if (!currentSession) { stopPolling(); return; }
  let data;
  try { data = await apiFetch(`/teleconference/${currentSession.id}/poll`); }
  catch (e) { return; }
  if (!data || !data.success) return;
  const p = data.data;

  // Sync key fields
  currentSession.session_status = p.session_status;
  if (p.started_at) currentSession.started_at = p.started_at; // keep the timer synced
  currentSession.recording_enabled = p.recording_enabled;
  currentSession.recording_requested = p.recording_requested;
  currentSession.recording_response = p.recording_response;
  currentSession.recording_consent_given = p.recording_consent_given;
  if (p.security_emojis) currentSession.security_emojis = p.security_emojis;
  currentSession.participants = p.participants;
  updateSecurityIndicator();

  // Status badge
  const badge = document.getElementById('session-status-badge');
  if (badge) { badge.textContent = p.session_status; badge.className = `meeting-status meeting-status--${p.session_status}`; }

  // Recording info + banner
  document.getElementById('info-recording').textContent = p.recording_enabled
    ? 'Active (Approved)'
    : p.recording_requested ? 'Requested'
    : p.recording_response === 0 ? 'Rejected' : 'Off';
  updateRecordingBanner();

  // Real-time session logs: if the host has the Logs panel open, refresh it
  // each poll so new events appear without reopening the panel.
  if (p.am_i_host && currentDrawer === 'logs') loadSessionLogs(currentSession.id);

  // Host: refresh waiting room list
  if (p.am_i_host) renderWaitingRoom(p.participants || []);

  // Everyone: refresh the participants roster (joined-only) + invited section
  renderParticipantsPanel(p.participants || []);

  // Removed by the host while in the call (host set status to denied + cleared joined_at)
  if (twilioRoom && !currentSession.am_i_host && p.my_admit_status === 'denied') {
    BPSToast.error('You were removed from the meeting by the host.', { title: 'Removed from Meeting' });
    leaveSession();
    return;
  }

  // New chat messages (only after joining)
  if (twilioRoom) loadChatMessages();

  // Waiting participant: auto-connect once admitted
  if (awaitingAdmission && p.my_admit_status === 'admitted' && !twilioRoom) {
    awaitingAdmission = false;
    BPSToast.success('The host admitted you. Connecting…', { title: 'Admitted' });
    try {
      const jd = await apiFetch(`/teleconference/${currentSession.id}/join`, { method: 'POST', body: JSON.stringify({ connectionToken: currentConnectionToken || undefined, reconnectToken: loadReconnectToken(currentSession.id) || undefined }) });
      if (jd.success && !jd.waiting && jd.data) await connectToRoom(jd.data);
    } catch (e) { console.error(e); }
  }
  if (awaitingAdmission && p.my_admit_status === 'denied') {
    awaitingAdmission = false;
    BPSToast.error('The host did not admit you to the session.', { title: 'Entry Not Granted' });
    leaveSession();
    return;
  }

  // A fresh recording request (pending, no decision yet) re-arms the popup
  if (p.recording_requested && (p.recording_response === null || p.recording_response === undefined) && recordingResponded) {
    recordingResponded = false;
  }

  // Client: show the real-time recording-consent popup while a request is pending
  if (user.id === currentSession.client_id &&
      p.recording_requested &&
      (p.recording_response === null || p.recording_response === undefined) &&
      !recordingResponded && !recordingPromptOpen) {
    recordingPromptOpen = true;
    document.getElementById('recording-consent-modal').style.display = 'flex';
  }

  // Session ended remotely by the host — notify everyone and send them to the
  // post-session page (works whether we're in the room or on the pre-join
  // screen). onHostEnded() is idempotent.
  if (p.session_status === 'ended') {
    onHostEnded();
    return;
  }
}

// ===== WAITING ROOM (host) =====
function renderWaitingRoom(participants) {
  if (!currentSession || !currentSession.am_i_host) return;
  const waiting = (participants || []).filter(p => p.admit_status === 'waiting');
  const badge = document.getElementById('waiting-count-badge');
  const list = document.getElementById('waiting-room-list');

  if (badge) {
    if (waiting.length) { badge.style.display = 'inline-block'; badge.textContent = waiting.length; }
    else badge.style.display = 'none';
  }

  if (!waiting.length) {
    list.innerHTML = '<div class="participant-placeholder">No one is waiting</div>';
    return;
  }

  list.innerHTML = waiting.map(p => {
    const dn = p.display_name || p.full_name || 'Participant';
    return `
    <div class="waiting-item" data-name="${escHtml(dn)}">
      <div class="waiting-item__info">
        <div class="participant-avatar">${(dn || '?')[0]}</div>
        <span>${escHtml(dn)} <span class="role-badge role-badge--${p.participant_role}">${roleLabel(p.participant_role)}</span></span>
      </div>
      <div class="waiting-item__actions">
        <button class="btn-admit" onclick="admitWaiting(${p.user_id}, true)">Admit</button>
        <button class="btn-deny" onclick="admitWaiting(${p.user_id}, false)">Deny</button>
      </div>
    </div>`;
  }).join('');
}

async function admitWaiting(userId, admit) {
  if (!currentSession) return;
  const data = await apiFetch(`/teleconference/${currentSession.id}/admit`, {
    method: 'PUT', body: JSON.stringify({ user_id: userId, admit }),
  });
  if (data.success) {
    BPSToast.success(admit ? 'Participant admitted.' : 'Participant denied.', { title: 'Waiting Room' });
    pollLoop();
  } else {
    BPSToast.error(data.message || 'Failed to update waiting room.', { title: 'Error' });
  }
}

// ===== END SESSION =====
// HOST-ONLY: end the teleconference for everyone. The button is only rendered
// for the host (buildToolbar), and the backend re-checks host RBAC.
function endSessionAction() {
  if (!currentSession) return;
  tcOpenConfirm('End Call for All',
    'This will end the teleconference and disconnect everyone immediately. Continue?',
    async () => {
      const data = await apiFetch(`/teleconference/${currentSession.id}/end`, { method: 'PUT' });
      if (data.success) {
        sessionWasEnded = true;            // suppress our own auto-reconnect
        BPSToast.success('The call has been ended for all participants.', { title: 'Call Ended' });
        leaveSession();
      } else if (data.code === 'NOT_HOST') {
        BPSToast.error('Only the host can end the call for everyone.', { title: 'Not Allowed' });
      } else {
        BPSToast.error(data.message || 'Failed to end the call.', { title: 'Error' });
      }
    });
}

async function stopRecording() {
  if (!currentSession) return;
  const data = await apiFetch(`/teleconference/${currentSession.id}/stop-recording`, { method: 'PUT' });
  if (data.success) {
    currentSession.recording_enabled = false;
    currentSession.recording_consent_given = false;
    currentSession.recording_response = null;
    recordingResponded = false;
    updateRecordingBanner();
    document.getElementById('btn-start-recording').style.display = 'flex';
    document.getElementById('btn-stop-recording').style.display = 'none';
    BPSToast.info('Recording stopped.', { title: 'Recording' });
  } else {
    BPSToast.error(data.message || 'Failed to stop recording.', { title: 'Recording Error' });
  }
}

function endSessionDirect(sessionId) {
  tcOpenConfirm('End Session', 'End this session?', async () => {
    const data = await apiFetch(`/teleconference/${sessionId}/end`, { method: 'PUT' });
    if (data.success) {
      BPSToast.success('Session ended.', { title: 'Session Ended' });
      if (isStaffUser) loadStaffDashboard(); else loadSessions();
    } else BPSToast.error(data.message || 'Failed.', { title: 'Error' });
  });
}

// ===== SESSION LOGS =====
async function loadSessionLogs(sessionId) {
  const data = await apiFetch(`/teleconference/${sessionId}/logs`);
  const list = document.getElementById('session-logs-list');

  if (!data.success || !data.data.length) {
    list.innerHTML = '<div class="log-empty">No logs yet</div>';
    return;
  }

  list.innerHTML = data.data.map(log => `
    <div class="log-item">
      <div class="log-item__event">${escHtml(log.event_type.replace(/_/g, ' '))}</div>
      <div class="log-item__detail">${escHtml(log.participant_name || 'System')} — ${escHtml(log.details || '')}</div>
      <div class="log-item__time">${formatDateTime(log.created_at)}</div>
    </div>
  `).join('');
}

// ===== IN-MEETING CHAT =====
function resetChat() {
  lastMessageId = 0;
  const box = document.getElementById('chat-messages');
  if (box) box.innerHTML = '<div class="chat-empty">No messages yet</div>';
}

function chatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function loadChatMessages() {
  if (!currentSession) return;
  let data;
  try {
    data = await apiFetch(`/teleconference/${currentSession.id}/messages?since=${lastMessageId}`);
  } catch (e) { return; }
  if (!data || !data.success || !data.data || !data.data.length) return;

  const box = document.getElementById('chat-messages');
  // Clear the placeholder on first real message
  const placeholder = box.querySelector('.chat-empty');
  if (placeholder) placeholder.remove();

  const atBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;

  data.data.forEach(m => {
    lastMessageId = Math.max(lastMessageId, m.id);
    const mine = m.user_id === user.id;
    const div = document.createElement('div');
    div.className = `chat-msg ${mine ? 'chat-msg--mine' : ''}`;
    div.innerHTML = `
      <div class="chat-msg__head">
        <span class="chat-msg__author">${mine ? 'You' : escHtml(m.full_name || 'Participant')}</span>
        <span class="chat-msg__time">${chatTime(m.created_at)}</span>
      </div>
      <div class="chat-msg__body">${escHtml(m.message)}</div>`;
    box.appendChild(div);
  });

  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function sendChatMessage() {
  if (!currentSession) return;
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    const data = await apiFetch(`/teleconference/${currentSession.id}/messages`, {
      method: 'POST', body: JSON.stringify({ message: text }),
    });
    if (data.success) {
      await loadChatMessages();
      const box = document.getElementById('chat-messages');
      box.scrollTop = box.scrollHeight;
    } else {
      BPSToast.error(data.message || 'Failed to send message.', { title: 'Chat Error' });
    }
  } catch (e) {
    BPSToast.error('Failed to send message.', { title: 'Chat Error' });
  }
}

// ===== DEEP-LINK: join a specific meeting straight from a notification =====
// When the user clicks "Join Meeting" in the notification pop-up they land on
// meetings.html?join=<id>. We take them directly into THAT meeting — no
// schedule list, no extra pop-up.
async function autoJoinMeeting(sessionId) {
  if (!sessionId || isNaN(sessionId)) return;
  // openSession() runs the CAPTCHA gate first; if the user cancels it, it
  // returns false and we must NOT proceed into the meeting.
  const opened = await openSession(sessionId);
  if (!opened) return;
  if (!currentSession || currentSession.id !== sessionId) {
    BPSToast.error('That meeting could not be opened.', { title: 'Meeting Unavailable' });
    return;
  }
  if (currentSession.session_status === 'ended' || currentSession.session_status === 'cancelled') {
    BPSToast.info('This meeting has already ended.', { title: 'Session Ended' });
    return;
  }

  BPSTeleconfOtp.touchSession(currentSession && currentSession.id);

  const btn = document.getElementById('btn-join');
  btn.disabled = true; btn.textContent = 'Joining…';

  try {
    const data = await apiFetch(`/teleconference/${currentSession.id}/join`, { method: 'POST', body: JSON.stringify({ connectionToken: currentConnectionToken || undefined, reconnectToken: loadReconnectToken(currentSession.id) || undefined }) });
    if (!data.success) {
      BPSToast.error(data.message || 'Failed to join the meeting.', { title: 'Join Error' });
      btn.disabled = false; btn.textContent = 'Join Session';
      return;
    }
    if (data.waiting) {
      awaitingAdmission = true;
      showWaitingOverlay();
      BPSToast.info('Waiting for the host to admit you.', { title: 'Waiting Room' });
      btn.disabled = true; btn.textContent = 'Waiting for host…';
      return;
    }
    await connectToRoom(data.data);
  } catch (err) {
    console.error('Auto-join failed:', err);
    BPSToast.error('Failed to join the meeting. Please try again.', { title: 'Join Error' });
    btn.disabled = false; btn.textContent = 'Join Session';
  }
}

// ===== SYSTEM MODALS =====
let _tcConfirmCb = null;

function tcOpenConfirm(title, msg, cb) {
  _tcConfirmCb = cb;
  document.getElementById('tc-confirm-title').textContent = title;
  document.getElementById('tc-confirm-msg').textContent = msg;
  document.getElementById('tc-confirm-modal').style.display = 'flex';
}

function tcConfirmYes() {
  document.getElementById('tc-confirm-modal').style.display = 'none';
  if (_tcConfirmCb) { const cb = _tcConfirmCb; _tcConfirmCb = null; cb(); }
}

function tcConfirmNo() {
  document.getElementById('tc-confirm-modal').style.display = 'none';
  _tcConfirmCb = null;
}

function tcOpenSecurityDetails() {
  const emojis = document.getElementById('secure-emojis').textContent;
  document.getElementById('tc-security-emojis').textContent = emojis;
  document.getElementById('tc-security-modal').style.display = 'flex';
}

/* ══════════════════════════════════════════════════════════════════════
   CLIENT TELECONFERENCE DASHBOARD
   A calm, scheduling-centered patient view shown ONLY to clients. It is
   driven by two endpoints the client can already call:
     • GET /api/appointments    → the schedule (date/time/therapist/status)
     • GET /api/teleconference  → the client's live rooms (join state)
   The "Join Meeting" action reuses the existing per-session OTP flow
   (openSession), so joining a call is gated by an email OTP every time —
   identical to the staff teleconference experience.
   ══════════════════════════════════════════════════════════════════════ */

let clientCountdownTimer = null;

// Soonest meaningful timestamp for an appointment.
function apptWhen(a) {
  return a.approved_datetime || a.proposed_datetime || a.preferred_datetime || a.created_at;
}

// Teleconference-relevant appointments: Online/virtual modality, or unspecified
// (legacy), or anything that already has a live room. Face-to-Face visits are
// excluded — this is the teleconference portal.
function isTeleconfAppt(a, sessionByAppt) {
  if (sessionByAppt && sessionByAppt[a.id]) return true;
  const m = (a.modality || '').toLowerCase();
  if (!m) return true;
  return /online|virtual|tele|video|remote/.test(m);
}

// Friendly, human status badge per appointment.
function apptBadge(status) {
  const map = {
    confirmed:            { label: 'Confirmed',  cls: 'cd-badge--confirmed' },
    approved:             { label: 'Scheduled',  cls: 'cd-badge--scheduled' },
    reschedule_proposed:  { label: 'Reschedule', cls: 'cd-badge--pending'   },
    pending_review:       { label: 'Pending',    cls: 'cd-badge--pending'   },
    completed:            { label: 'Completed',  cls: 'cd-badge--completed' },
    declined:             { label: 'Declined',   cls: 'cd-badge--muted'     },
    cancelled:            { label: 'Cancelled',  cls: 'cd-badge--muted'     },
  };
  return map[status] || { label: status || 'Scheduled', cls: 'cd-badge--scheduled' };
}

function greetingForNow() {
  const h = new Date().getHours();
  if (h < 12) return { text: 'Good morning', emoji: '🌅' };
  if (h < 18) return { text: 'Good afternoon', emoji: '☀️' };
  return { text: 'Good evening', emoji: '🌙' };
}

const WELLNESS_MESSAGES = [
  'Taking time for your mental health is a sign of strength.',
  'Every session is a step forward. We are glad you are here.',
  'Your well-being matters — one conversation at a time.',
  'Healing is not linear, and showing up already counts.',
  'A calm mind begins with a single, gentle moment.',
];

function clientFirstName() {
  const n = (user.full_name || '').trim();
  return n ? n.split(/\s+/)[0] : 'there';
}

// Loading skeleton — gentle placeholders while data arrives.
function renderClientSkeleton() {
  const root = document.getElementById('client-dashboard-view');
  root.innerHTML = `
    <div class="cd-hero cd-skeleton-block" style="height:120px;"></div>
    <div class="cd-kpi-row">
      ${'<div class="cd-card cd-skeleton-block" style="height:108px;"></div>'.repeat(4)}
    </div>
    <div class="cd-main-grid">
      <div class="cd-skeleton-block" style="height:230px;border-radius:20px;"></div>
      <div class="cd-skeleton-block" style="height:230px;border-radius:20px;"></div>
    </div>`;
}

// Cached so the live-state poll can re-render without re-fetching appointments
// (which change rarely), and to compute a signature of the live state.
let clientApptsCache = [];
let clientDashPollTimer = null;
let lastLiveSignature = '';

// A compact fingerprint of what drives the Join button + Live/Scheduled badge:
// each room's id + status + whether the host is currently present.
function liveSignature(sessions) {
  return sessions
    .map(s => `${s.id}:${s.session_status}:${s.host_present ? 1 : 0}`)
    .sort()
    .join('|');
}

async function loadClientDashboard() {
  renderClientSkeleton();
  let appts = [], sessions = [];
  try {
    const [aRes, sRes] = await Promise.all([
      apiFetch('/appointments'),
      apiFetch('/teleconference'),
    ]);
    appts    = (aRes && aRes.success && Array.isArray(aRes.data)) ? aRes.data : [];
    sessions = (sRes && sRes.success && Array.isArray(sRes.data)) ? sRes.data : [];
  } catch (e) {
    console.error('Dashboard load failed:', e);
  }
  clientApptsCache = appts;
  lastLiveSignature = liveSignature(sessions);
  renderClientDashboard(appts, sessions);
  startClientDashPoll();
}

// Poll the live rooms every 15s so the Join button + host name appear the
// moment the host starts a session, and vanish when the host ends it — no
// manual refresh. Only re-renders when the live state actually changed, so the
// countdown keeps ticking smoothly in between.
function startClientDashPoll() {
  if (clientDashPollTimer) { clearInterval(clientDashPollTimer); clientDashPollTimer = null; }
  clientDashPollTimer = setInterval(async () => {
    const view = document.getElementById('client-dashboard-view');
    if (!view || view.style.display === 'none') return; // paused while in a call
    let sessions = [];
    try {
      const sRes = await apiFetch('/teleconference');
      sessions = (sRes && sRes.success && Array.isArray(sRes.data)) ? sRes.data : [];
    } catch (_) { return; } // transient — try again next tick
    const sig = liveSignature(sessions);
    if (sig !== lastLiveSignature) {
      lastLiveSignature = sig;
      renderClientDashboard(clientApptsCache, sessions);
    }
  }, 15000);
}

function renderClientDashboard(appts, sessions) {
  const root = document.getElementById('client-dashboard-view');

  // Joinable rooms = sessions the host has created and invited this client to,
  // that have NOT ended/cancelled. The moment the host ends the call the row
  // leaves this list, so the Join button vanishes on the next refresh.
  const joinable = sessions.filter(s => s.session_status === 'scheduled' || s.session_status === 'active');
  const sessionByAppt = {};
  joinable.forEach(s => { if (s.appointment_id) sessionByAppt[s.appointment_id] = s; });

  const now = Date.now();
  const relevant = appts.filter(a => isTeleconfAppt(a, sessionByAppt));

  const upcoming = relevant
    .filter(a => ['confirmed', 'approved', 'reschedule_proposed'].includes(a.status))
    .filter(a => new Date(apptWhen(a)).getTime() > now - 60 * 60 * 1000) // keep within last hour as "now"
    .sort((x, y) => new Date(apptWhen(x)) - new Date(apptWhen(y)));

  const completed = relevant.filter(a => a.status === 'completed');
  const totalSessions = relevant.filter(a => ['confirmed', 'approved', 'completed', 'reschedule_proposed'].includes(a.status)).length;

  // Minutes this month from ENDED rooms (the only place we have real durations).
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  let minutesThisMonth = 0;
  sessions.forEach(s => {
    if (s.started_at && s.ended_at && new Date(s.ended_at) >= monthStart) {
      const mins = (new Date(s.ended_at) - new Date(s.started_at)) / 60000;
      if (mins > 0 && mins < 24 * 60) minutesThisMonth += mins;
    }
  });
  minutesThisMonth = Math.round(minutesThisMonth);

  const next = upcoming[0] || null;
  // The client's LIVE room, if the host has started one and invited them. Prefer
  // a room explicitly linked to the next appointment; otherwise surface any live
  // room they are a participant of. When none is live (not started yet, or the
  // host ended it) this is null — and no Join button is shown.
  const primaryLive = (next && sessionByAppt[next.id]) || joinable[0] || null;

  const greet = greetingForNow();
  const wellness = WELLNESS_MESSAGES[new Date().getDate() % WELLNESS_MESSAGES.length];

  root.innerHTML = `
    <!-- HERO -->
    <section class="cd-hero">
      <div class="cd-hero__blob cd-hero__blob--1"></div>
      <div class="cd-hero__blob cd-hero__blob--2"></div>
      <div class="cd-hero__content">
        <h1 class="cd-hero__greeting">${greet.text}, ${escHtml(clientFirstName())} <span class="cd-wave">${greet.emoji}</span></h1>
        <p class="cd-hero__sub">${
          upcoming.length
            ? `You have <strong>${upcoming.length}</strong> upcoming session${upcoming.length > 1 ? 's' : ''}. ${escHtml(wellness)}`
            : escHtml(wellness)
        }</p>
      </div>
    </section>

    <!-- KPI CARDS -->
    <div class="cd-kpi-row">
      ${kpiCard('calendar-clock', 'Upcoming Sessions', upcoming.length, next ? formatShort(apptWhen(next)) : 'None scheduled', 'kpi--green')}
      ${kpiCard('check-circle-2', 'Completed Sessions', completed.length, 'Your history', 'kpi--blue')}
      ${kpiCard('video', 'Total Sessions', totalSessions, 'All-time sessions', 'kpi--violet')}
      ${kpiCard('timer', 'Minutes This Month', minutesThisMonth, 'Total meeting time', 'kpi--amber')}
    </div>

    <div class="cd-main-grid">
      <div class="cd-col cd-col--left">
        ${renderUpcomingCard(next, primaryLive)}
        ${renderRecentMeetings(sessions, primaryLive)}
      </div>
      <div class="cd-col cd-col--right">
        ${renderQuickActions()}
        ${renderPrepPanel()}
        ${renderAssistPanel()}
      </div>
    </div>`;

  if (window.lucide) lucide.createIcons();
}

function formatShort(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function kpiCard(icon, label, value, sub, mod) {
  return `
    <div class="cd-card cd-kpi ${mod}">
      <div class="cd-kpi__icon"><i data-lucide="${icon}"></i></div>
      <div class="cd-kpi__body">
        <div class="cd-kpi__label">${escHtml(label)}</div>
        <div class="cd-kpi__value">${escHtml(String(value))}</div>
        <div class="cd-kpi__sub">${escHtml(sub)}</div>
      </div>
    </div>`;
}

// Shared facts row (date · time · modality) for a scheduled appointment.
function upcomingFacts(appt) {
  const when = new Date(apptWhen(appt));
  return `
    <div class="cd-upcoming__facts">
      <span><i data-lucide="calendar"></i> ${escHtml(when.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}</span>
      <span><i data-lucide="clock"></i> ${escHtml(when.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }))}</span>
      ${appt.modality ? `<span><i data-lucide="monitor"></i> ${escHtml(appt.modality)}</span>` : ''}
    </div>`;
}

const SECURE_NOTE = `<div class="cd-upcoming__secure"><i data-lucide="shield-check"></i> Your meeting is secured — all teleconferences are encrypted and confidential.</div>`;

// The Upcoming Meeting card.
//   • live  → the host has started a room and invited this client: show the
//             host's name + a Join Meeting button. THIS is the only thing that
//             ever renders in this card.
//   • else  → no room is live (not started, or the host ended it): show a calm
//             empty state — no scheduled card, no countdown.
function renderUpcomingCard(next, live) {
  if (!live) {
    return `
      <section class="cd-card cd-upcoming cd-upcoming--empty">
        <div class="cd-upcoming__emptyart"><i data-lucide="calendar-heart"></i></div>
        <h2 class="cd-upcoming__emptytitle">No meeting in progress</h2>
        <p class="cd-upcoming__emptytext">When your therapist starts your session, a Join button will appear right here.</p>
      </section>`;
  }

  // A live room exists → host name + Join. Shows the linked appointment's
  // date/time for context ONLY when the room is actually tied to that appointment.
  const linkedAppt = (next && live.appointment_id && live.appointment_id === next.id) ? next : null;
  const title = live.meeting_title || (linkedAppt && linkedAppt.assessment_type) || 'Counseling Session';
  return `
    <section class="cd-card cd-upcoming cd-upcoming--live">
      <div class="cd-upcoming__head">
        <span class="cd-upcoming__eyebrow"><i data-lucide="calendar-check"></i> Meeting Today</span>
        ${live.host_present
          ? `<span class="cd-upcoming__livebadge"><span class="cd-livedot"></span> Live now</span>`
          : `<span class="cd-badge cd-badge--scheduled">Scheduled</span>`}
      </div>
      <div class="cd-upcoming__row">
        <div class="cd-upcoming__meta">
          <h2 class="cd-upcoming__title">${escHtml(title)}</h2>
          <p class="cd-upcoming__with"><i data-lucide="user-round"></i> with ${escHtml(live.psychologist_name || 'your therapist')}</p>
          ${linkedAppt ? upcomingFacts(linkedAppt) : ''}
        </div>
        <div class="cd-upcoming__cta">
          <button class="cd-btn cd-btn--join" onclick="openSession(${live.id})"><i data-lucide="video"></i> Join Meeting</button>
        </div>
      </div>
      ${SECURE_NOTE}
    </section>`;
}

// Status badge for an actual teleconference room (not an appointment).
function sessionBadge(status) {
  const map = {
    active:    { label: 'Live now',  cls: 'cd-badge--confirmed' },
    scheduled: { label: 'Scheduled', cls: 'cd-badge--scheduled' },
    ended:     { label: 'Completed', cls: 'cd-badge--completed' },
    cancelled: { label: 'Cancelled', cls: 'cd-badge--muted'     },
  };
  return map[status] || { label: status || 'Meeting', cls: 'cd-badge--scheduled' };
}

// "My Schedule" now lists the client's RECENT meetings (their real teleconference
// rooms), newest first. The currently-live room (already shown in the hero card)
// is excluded to avoid duplication. Live/scheduled rooms still offer a Join.
function renderRecentMeetings(sessions, primaryLive) {
  const excludeId = primaryLive ? primaryLive.id : null;
  // Show a deeper history now that the list scrolls inside its own card.
  const recent = sessions
    .filter(s => s.id !== excludeId)
    .slice()
    .sort((a, b) => new Date(b.started_at || b.created_at) - new Date(a.started_at || a.created_at))
    .slice(0, 25);

  const rows = recent.length ? recent.map(s => {
    const when = new Date(s.started_at || s.created_at);
    const badge = sessionBadge(s.session_status);
    const canJoin = s.session_status === 'active' || s.session_status === 'scheduled';
    return `
      <div class="cd-sched__item">
        <div class="cd-sched__date">
          <span class="cd-sched__mon">${when.toLocaleDateString('en-PH', { month: 'short' }).toUpperCase()}</span>
          <span class="cd-sched__day">${when.getDate()}</span>
          <span class="cd-sched__dow">${when.toLocaleDateString('en-PH', { weekday: 'short' }).toUpperCase()}</span>
        </div>
        <div class="cd-sched__info">
          <div class="cd-sched__title">${escHtml(s.meeting_title || 'Consultation Session')}</div>
          <div class="cd-sched__with">with ${escHtml(s.psychologist_name || 'your therapist')}</div>
          <div class="cd-sched__time"><i data-lucide="clock"></i> ${escHtml(when.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</div>
        </div>
        <div class="cd-sched__side">
          <span class="cd-badge ${badge.cls}">${escHtml(badge.label)}</span>
          ${canJoin ? `<button class="cd-btn cd-btn--joinsm" onclick="openSession(${s.id})"><i data-lucide="video"></i> Join</button>` : ''}
        </div>
      </div>`;
  }).join('') : `
      <div class="cd-sched__empty">
        <div class="cd-sched__emptyart"><i data-lucide="history"></i></div>
        <div class="cd-sched__emptytitle">No recent meetings</div>
        <p class="cd-sched__emptytext">Your past and upcoming teleconference meetings will appear here.</p>
      </div>`;

  return `
    <section class="cd-card cd-sched">
      <div class="cd-card__head"><h3><i data-lucide="history"></i> Recent Meetings</h3></div>
      <div class="cd-sched__list">${rows}</div>
    </section>`;
}

function renderQuickActions() {
  return `
    <section class="cd-card cd-quick">
      <div class="cd-card__head"><h3><i data-lucide="zap"></i> Quick Actions</h3></div>
      <a class="cd-quick__item" href="intakeform.html">
        <span class="cd-quick__ic cd-quick__ic--green"><i data-lucide="calendar-plus"></i></span>
        <span class="cd-quick__txt"><strong>Schedule a Meeting</strong><small>Book a new session</small></span>
        <i data-lucide="chevron-right" class="cd-quick__chev"></i>
      </a>
      <a class="cd-quick__item" href="profile.html">
        <span class="cd-quick__ic cd-quick__ic--blue"><i data-lucide="history"></i></span>
        <span class="cd-quick__txt"><strong>Session History</strong><small>Review past sessions</small></span>
        <i data-lucide="chevron-right" class="cd-quick__chev"></i>
      </a>
      <button type="button" class="cd-quick__item" onclick="testClientConnection(this)">
        <span class="cd-quick__ic cd-quick__ic--violet"><i data-lucide="radio"></i></span>
        <span class="cd-quick__txt"><strong>Test My Connection</strong><small>Check your camera &amp; microphone</small></span>
        <i data-lucide="chevron-right" class="cd-quick__chev"></i>
      </button>
    </section>`;
}

function renderPrepPanel() {
  const tips = [
    { ic: 'clock', t: 'Join 5 minutes early', d: 'Ensure a smooth start to your session.' },
    { ic: 'volume-2', t: 'Use a quiet environment', d: 'Reduce background noise for clearer conversation.' },
    { ic: 'wifi', t: 'Check your internet connection', d: 'A stable connection keeps the call smooth.' },
  ];
  return `
    <section class="cd-card cd-prep">
      <div class="cd-card__head"><h3><i data-lucide="sparkles"></i> Meeting Reminders</h3></div>
      ${tips.map(x => `
        <div class="cd-prep__item">
          <span class="cd-prep__ic"><i data-lucide="${x.ic}"></i></span>
          <div><div class="cd-prep__t">${x.t}</div><div class="cd-prep__d">${x.d}</div></div>
        </div>`).join('')}
    </section>`;
}

function renderAssistPanel() {
  return `
    <section class="cd-card cd-assist">
      <div class="cd-assist__icon"><i data-lucide="life-buoy"></i></div>
      <h3 class="cd-assist__title">Need Assistance?</h3>
      <p class="cd-assist__text">If you experience any issues during your meeting, our support team is ready to help.</p>
      <a class="cd-btn cd-btn--ghost" href="contact.html"><i data-lucide="headphones"></i> Contact Support</a>
    </section>`;
}

// Animated countdown to the next session.
function startClientCountdown(target, isLive) {
  if (clientCountdownTimer) { clearInterval(clientCountdownTimer); clientCountdownTimer = null; }
  const el = document.getElementById('cd-countdown');
  if (!el) return;
  if (isLive) { el.innerHTML = `<span class="cd-countdown__live"><span class="cd-livedot"></span> Live now</span>`; return; }
  if (!target) { el.innerHTML = ''; return; }

  const tick = () => {
    const diff = target.getTime() - Date.now();
    if (diff <= 0) {
      el.innerHTML = `<span class="cd-countdown__soon">Starting soon…</span>`;
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    const seg = (v, lbl) => `<span class="cd-cd__seg"><b>${String(v).padStart(2, '0')}</b><i>${lbl}</i></span>`;
    el.innerHTML = `<div class="cd-countdown__label">Starts in</div><div class="cd-countdown__clock">${
      (d > 0 ? seg(d, 'days') : '') + seg(h, 'hrs') + seg(m, 'min') + seg(s, 'sec')
    }</div>`;
  };
  tick();
  clientCountdownTimer = setInterval(tick, 1000);
}

// Pure client-side device check (no backend) — confirms the browser can reach
// the camera + microphone before a real call.
async function testClientConnection(btn) {
  const txt = btn.querySelector('.cd-quick__txt small');
  const original = txt ? txt.textContent : '';
  if (txt) txt.textContent = 'Checking…';
  btn.classList.add('cd-quick__item--busy');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach(t => t.stop());
    BPSToast.success('Your camera and microphone are working. You are ready to join.', { title: 'Connection OK' });
    if (txt) txt.textContent = 'Camera & microphone OK';
  } catch (e) {
    BPSToast.error('We could not access your camera or microphone. Please check your browser permissions.', { title: 'Connection Issue' });
    if (txt) txt.textContent = 'Check permissions and retry';
  } finally {
    btn.classList.remove('cd-quick__item--busy');
    setTimeout(() => { if (txt) txt.textContent = original; }, 6000);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   STAFF / CLINICAL DIRECTOR TELECONFERENCE DASHBOARD
   Same calming .cd-* design as the client, driven by the staff member's own
   teleconference rooms (the sessions they host or are added to). Adds the
   reference header toolbar — search, status filter, and a Schedule a Meeting
   button — that drive the meetings list below.
   ══════════════════════════════════════════════════════════════════════ */
let staffSessionsCache = [];
let staffSearchTerm = '';
let staffStatusFilter = '';
let staffDashPollTimer = null;
let staffLiveSignature = '';
let staffSelectsLoaded = false;

function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

async function loadStaffDashboard() {
  renderClientSkeleton(); // reuse the same gentle skeleton
  let sessions = [];
  try {
    const sRes = await apiFetch('/teleconference');
    sessions = (sRes && sRes.success && Array.isArray(sRes.data)) ? sRes.data : [];
  } catch (e) { console.error('Staff dashboard load failed:', e); }
  staffSessionsCache = sessions;
  staffLiveSignature = liveSignature(sessions);
  renderStaffDashboard(sessions);
  startStaffDashPoll();
  // Populate the Schedule-a-Meeting modal's selects ONCE (avoid duplicate
  // options on subsequent dashboard refreshes).
  if (!staffSelectsLoaded) { staffSelectsLoaded = true; loadClients(); loadStaff(); }
}

// Live-state poll: refreshes only the dynamic parts so the search box keeps
// focus and the toolbar never flickers.
function startStaffDashPoll() {
  if (staffDashPollTimer) { clearInterval(staffDashPollTimer); staffDashPollTimer = null; }
  staffDashPollTimer = setInterval(async () => {
    const view = document.getElementById('client-dashboard-view');
    if (!view || view.style.display === 'none') return;
    let sessions = [];
    try {
      const sRes = await apiFetch('/teleconference');
      sessions = (sRes && sRes.success && Array.isArray(sRes.data)) ? sRes.data : [];
    } catch (_) { return; }
    const sig = liveSignature(sessions);
    if (sig !== staffLiveSignature) {
      staffLiveSignature = sig;
      staffSessionsCache = sessions;
      updateStaffDynamic();
    }
  }, 15000);
}

// KPI metrics derived from the staff member's rooms.
function staffMetrics(sessions) {
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  let minutes = 0;
  sessions.forEach(s => {
    if (s.started_at && s.ended_at && new Date(s.ended_at) >= monthStart) {
      const m = (new Date(s.ended_at) - new Date(s.started_at)) / 60000;
      if (m > 0 && m < 24 * 60) minutes += m;
    }
  });
  const live = sessions.filter(s => s.session_status === 'scheduled' || s.session_status === 'active');
  return {
    upcoming: live.length,
    completed: sessions.filter(s => s.session_status === 'ended').length,
    total: sessions.length,
    minutes: Math.round(minutes),
    next: live.slice().sort((a, b) =>
      // active first, then newest scheduled
      (b.session_status === 'active') - (a.session_status === 'active') ||
      new Date(b.started_at || b.created_at) - new Date(a.started_at || a.created_at)
    )[0] || null,
  };
}

function staffKpis(m) {
  return (
    kpiCard('calendar-clock', 'Upcoming Sessions', m.upcoming, m.next ? 'Next session' : 'None scheduled', 'kpi--green') +
    kpiCard('check-circle-2', 'Completed Sessions', m.completed, 'View your history', 'kpi--blue') +
    kpiCard('video', 'Total Sessions', m.total, 'All-time sessions', 'kpi--violet') +
    kpiCard('timer', 'Minutes This Month', m.minutes, 'Total meeting time', 'kpi--amber')
  );
}

// Upcoming/live room the host can jump into.
function staffUpcomingCard(next) {
  if (!next) {
    return `
      <section class="cd-card cd-upcoming cd-upcoming--empty">
        <div class="cd-upcoming__emptyart"><i data-lucide="calendar-heart"></i></div>
        <h2 class="cd-upcoming__emptytitle">No active or scheduled meetings</h2>
        <p class="cd-upcoming__emptytext">Schedule a new consultation session to get started — it will appear here ready to join.</p>
        <button class="cd-btn cd-btn--primary" onclick="openScheduleModal()"><i data-lucide="calendar-plus"></i> Schedule a Meeting</button>
      </section>`;
  }
  const hostPresent = !!next.host_present;   // "Live now" only while the host is in the room
  const started = !!next.started_at;
  const when = new Date(next.started_at || next.created_at);
  return `
    <section class="cd-card cd-upcoming cd-upcoming--live">
      <div class="cd-upcoming__head">
        <span class="cd-upcoming__eyebrow"><i data-lucide="calendar-check"></i> Upcoming Meeting</span>
        <span class="${hostPresent ? 'cd-upcoming__livebadge' : 'cd-badge cd-badge--scheduled'}">${hostPresent ? '<span class="cd-livedot"></span> Live now' : 'Scheduled'}</span>
      </div>
      <div class="cd-upcoming__row">
        <div class="cd-upcoming__meta">
          <h2 class="cd-upcoming__title">${escHtml(next.meeting_title || 'Consultation Session')}</h2>
          <p class="cd-upcoming__with"><i data-lucide="user-round"></i> with ${escHtml(next.client_name || 'Client not assigned')}</p>
          <div class="cd-upcoming__facts">
            <span><i data-lucide="${started ? 'play-circle' : 'calendar'}"></i> ${escHtml(started ? 'Started' : 'Created')} ${escHtml(when.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span>
            <span><i data-lucide="hash"></i> ${escHtml(next.meeting_code || '—')}</span>
          </div>
        </div>
        <div class="cd-upcoming__cta">
          <button class="cd-btn cd-btn--join" onclick="openSession(${next.id})"><i data-lucide="video"></i> Join Meeting</button>
          ${next.session_status === 'active' ? `<button class="cd-btn cd-btn--ghost" onclick="endSessionDirect(${next.id})"><i data-lucide="phone-off"></i> End for All</button>` : ''}
        </div>
      </div>
      ${SECURE_NOTE}
    </section>`;
}

// The searchable / filterable meetings list (rows only).
function staffMeetingRows() {
  const term = staffSearchTerm.trim().toLowerCase();
  const rows = staffSessionsCache
    .filter(s => !staffStatusFilter || s.session_status === staffStatusFilter)
    .filter(s => {
      if (!term) return true;
      return [s.meeting_title, s.client_name, s.psychologist_name, s.meeting_code]
        .some(v => (v || '').toLowerCase().includes(term));
    })
    .slice()
    .sort((a, b) => new Date(b.started_at || b.created_at) - new Date(a.started_at || a.created_at))
    .slice(0, 40);

  if (!rows.length) {
    return `
      <div class="cd-sched__empty">
        <div class="cd-sched__emptyart"><i data-lucide="search-x"></i></div>
        <div class="cd-sched__emptytitle">${staffSessionsCache.length ? 'No matching meetings' : 'No meetings yet'}</div>
        <p class="cd-sched__emptytext">${staffSessionsCache.length ? 'Try a different search term or status filter.' : 'Schedule a meeting to see it listed here.'}</p>
      </div>`;
  }

  const isHost = (s) => s.psychologist_id === user.id;
  return rows.map(s => {
    const when = new Date(s.started_at || s.created_at);
    const badge = sessionBadge(s.session_status);
    const canJoin = s.session_status === 'active' || s.session_status === 'scheduled';
    return `
      <div class="cd-sched__item">
        <div class="cd-sched__date">
          <span class="cd-sched__mon">${when.toLocaleDateString('en-PH', { month: 'short' }).toUpperCase()}</span>
          <span class="cd-sched__day">${when.getDate()}</span>
          <span class="cd-sched__dow">${when.toLocaleDateString('en-PH', { weekday: 'short' }).toUpperCase()}</span>
        </div>
        <div class="cd-sched__info">
          <div class="cd-sched__title">${escHtml(s.meeting_title || 'Consultation Session')}</div>
          <div class="cd-sched__with">${escHtml(s.client_name ? 'with ' + s.client_name : 'No client assigned')}</div>
          <div class="cd-sched__time"><i data-lucide="clock"></i> ${escHtml(when.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</div>
        </div>
        <div class="cd-sched__side">
          <span class="cd-badge ${badge.cls}">${escHtml(badge.label)}</span>
          ${canJoin ? `<button class="cd-btn cd-btn--joinsm" onclick="openSession(${s.id})"><i data-lucide="video"></i> Join</button>` : ''}
          ${(s.session_status === 'active' && isHost(s)) ? `<button class="cd-btn cd-btn--endsm" onclick="endSessionDirect(${s.id})"><i data-lucide="phone-off"></i> End</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

// Re-render only the data-driven sections (keeps toolbar + search focus intact).
function updateStaffDynamic() {
  const m = staffMetrics(staffSessionsCache);
  const kpis = document.getElementById('staff-kpis');
  const up = document.getElementById('staff-upcoming');
  const list = document.getElementById('staff-meetings-list');
  if (kpis) kpis.innerHTML = staffKpis(m);
  if (up) up.innerHTML = staffUpcomingCard(m.next);
  if (list) list.innerHTML = staffMeetingRows();
  if (window.lucide) lucide.createIcons();
}

function renderStaffDashboard(sessions) {
  const root = document.getElementById('client-dashboard-view');
  const m = staffMetrics(sessions);
  const greet = greetingForNow();
  const statusOpt = (v, label) => `<option value="${v}"${staffStatusFilter === v ? ' selected' : ''}>${label}</option>`;

  root.innerHTML = `
    <!-- HERO + TOOLBAR -->
    <section class="cd-hero">
      <div class="cd-hero__blob cd-hero__blob--1"></div>
      <div class="cd-hero__blob cd-hero__blob--2"></div>
      <div class="cd-hero__row">
        <div class="cd-hero__content">
          <h1 class="cd-hero__greeting">${greet.text}, ${escHtml(clientFirstName())} <span class="cd-wave">${greet.emoji}</span></h1>
          <p class="cd-hero__sub">Here's your teleconference overview and upcoming sessions.</p>
        </div>
        <div class="cd-toolbar">
          <div class="cd-search">
            <i data-lucide="search"></i>
            <input type="text" id="staff-search" placeholder="Search meetings, clients, or codes…" value="${escAttr(staffSearchTerm)}" oninput="onStaffSearch(this.value)">
          </div>
          <select class="cd-filter" id="staff-filter" data-bps-skip onchange="onStaffFilter(this.value)" aria-label="Filter by status">
            ${statusOpt('', 'All status')}${statusOpt('scheduled', 'Scheduled')}${statusOpt('active', 'Active')}${statusOpt('ended', 'Ended')}
          </select>
          <button class="cd-btn cd-btn--join cd-toolbar__cta" onclick="openScheduleModal()"><i data-lucide="calendar-plus"></i> Schedule a Meeting</button>
        </div>
      </div>
    </section>

    <!-- KPI CARDS -->
    <div class="cd-kpi-row" id="staff-kpis">${staffKpis(m)}</div>

    <div class="cd-main-grid">
      <div class="cd-col cd-col--left">
        <div id="staff-upcoming">${staffUpcomingCard(m.next)}</div>
        <section class="cd-card cd-sched">
          <div class="cd-card__head"><h3><i data-lucide="list"></i> My Meetings</h3></div>
          <div class="cd-sched__list" id="staff-meetings-list">${staffMeetingRows()}</div>
        </section>
      </div>
      <div class="cd-col cd-col--right">
        ${renderStaffQuickActions()}
        ${renderPrepPanel()}
        ${renderAssistPanel()}
      </div>
    </div>`;

  if (window.lucide) lucide.createIcons();
}

function renderStaffQuickActions() {
  return `
    <section class="cd-card cd-quick">
      <div class="cd-card__head"><h3><i data-lucide="zap"></i> Quick Actions</h3></div>
      <button type="button" class="cd-quick__item" onclick="openScheduleModal()">
        <span class="cd-quick__ic cd-quick__ic--green"><i data-lucide="calendar-plus"></i></span>
        <span class="cd-quick__txt"><strong>Schedule a Meeting</strong><small>Start a new consultation session</small></span>
        <i data-lucide="chevron-right" class="cd-quick__chev"></i>
      </button>
      <a class="cd-quick__item" href="case-dashboard.html">
        <span class="cd-quick__ic cd-quick__ic--blue"><i data-lucide="folder-open"></i></span>
        <span class="cd-quick__txt"><strong>Case Management</strong><small>Open client cases</small></span>
        <i data-lucide="chevron-right" class="cd-quick__chev"></i>
      </a>
      <button type="button" class="cd-quick__item" onclick="testClientConnection(this)">
        <span class="cd-quick__ic cd-quick__ic--violet"><i data-lucide="radio"></i></span>
        <span class="cd-quick__txt"><strong>Test My Connection</strong><small>Check your camera &amp; microphone</small></span>
        <i data-lucide="chevron-right" class="cd-quick__chev"></i>
      </button>
      <button type="button" class="cd-quick__item" onclick="openRecordings()">
        <span class="cd-quick__ic cd-quick__ic--blue"><i data-lucide="play-circle"></i></span>
        <span class="cd-quick__txt"><strong>View Recordings</strong><small>Watch your past session recordings</small></span>
        <i data-lucide="chevron-right" class="cd-quick__chev"></i>
      </button>
    </section>`;
}

function onStaffSearch(value) { staffSearchTerm = value; const l = document.getElementById('staff-meetings-list'); if (l) { l.innerHTML = staffMeetingRows(); if (window.lucide) lucide.createIcons(); } }
function onStaffFilter(value) { staffStatusFilter = value; const l = document.getElementById('staff-meetings-list'); if (l) { l.innerHTML = staffMeetingRows(); if (window.lucide) lucide.createIcons(); } }

// ── Schedule-a-Meeting modal ──
function openScheduleModal() {
  selectedStaff = [];
  renderSelectedStaff();
  const t = document.getElementById('session-title'); if (t) t.value = '';
  const cs = document.getElementById('client-select'); if (cs) cs.value = '';
  const ss = document.getElementById('staff-select'); if (ss) ss.value = '';
  const m = document.getElementById('schedule-modal'); if (m) m.style.display = 'flex';
}
function closeScheduleModal() {
  const m = document.getElementById('schedule-modal'); if (m) m.style.display = 'none';
  selectedStaff = [];
  renderSelectedStaff();
}

// ── Session Recordings (host + invited staff) ──
// Lists ended sessions that have a stored recording and plays them inline via a
// short-lived presigned URL from GET /teleconference/:id/recording. The list is
// built from the host's own sessions cache, so only rooms they host or were
// added to appear here.
function openRecordings() {
  renderRecordingsList();
  const wrap = document.getElementById('recording-player-wrap'); if (wrap) wrap.style.display = 'none';
  const m = document.getElementById('recordings-modal'); if (m) m.style.display = 'flex';
  if (window.lucide) lucide.createIcons();
}

function closeRecordings() {
  const m = document.getElementById('recordings-modal'); if (m) m.style.display = 'none';
  const v = document.getElementById('recording-player');
  // Don't leave the presigned URL sitting in the DOM after the modal closes.
  if (v) { v.pause(); v.onerror = null; v.removeAttribute('src'); v.load(); }
}

function renderRecordingsList() {
  const wrap = document.getElementById('recordings-list');
  if (!wrap) return;
  const recs = (staffSessionsCache || [])
    .filter(s => s.session_status === 'ended' && s.recording_url)
    .sort((a, b) => new Date(b.ended_at || b.started_at || b.created_at) - new Date(a.ended_at || a.started_at || a.created_at));

  if (!recs.length) {
    wrap.innerHTML = `
      <div class="cd-sched__empty">
        <div class="cd-sched__emptyart"><i data-lucide="video-off"></i></div>
        <div class="cd-sched__emptytitle">No recordings yet</div>
        <p class="cd-sched__emptytext">Recorded sessions appear here once they end and finish processing.</p>
      </div>`;
    return;
  }

  wrap.innerHTML = recs.map(s => {
    const when = new Date(s.ended_at || s.started_at || s.created_at);
    return `
      <div class="cd-sched__item">
        <div class="cd-sched__info">
          <div class="cd-sched__title">${escHtml(s.meeting_title || 'Consultation Session')}</div>
          <div class="cd-sched__with">${escHtml(s.client_name ? 'with ' + s.client_name : 'No client assigned')}</div>
          <div class="cd-sched__time"><i data-lucide="clock"></i> ${escHtml(when.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</div>
        </div>
        <div class="cd-sched__side">
          <button class="cd-btn cd-btn--joinsm" onclick="viewRecording(${s.id})"><i data-lucide="play"></i> Play</button>
        </div>
      </div>`;
  }).join('');
}

async function viewRecording(id) {
  const data = await apiFetch(`/teleconference/${id}/recording`);
  if (!data || !data.success) {
    BPSToast.info(data && data.code === 'NO_RECORDING'
      ? 'Recording is still processing — check back shortly.'
      : ((data && data.message) || 'Recording is unavailable.'), { title: 'Recording' });
    return;
  }
  const wrap = document.getElementById('recording-player-wrap');
  const v = document.getElementById('recording-player');
  const dl = document.getElementById('recording-download');
  if (dl) dl.href = data.data.url;
  if (v) {
    v.src = data.data.url;
    // Presigned URLs expire (~300s); if playback fails after expiry, mint a fresh one.
    v.onerror = () => { v.onerror = null; viewRecording(id); };
    if (wrap) { wrap.style.display = 'block'; wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    v.play().catch(() => {});
  }
}

// ===== INIT =====
if (window.lucide) lucide.createIcons();
const _dashView = document.getElementById('client-dashboard-view');
const _listView = document.getElementById('sessions-list-view');
if (_listView) _listView.style.display = 'none';
if (_dashView) _dashView.style.display = 'block';
document.body.classList.add('cd-client-mode');
if (isStaffUser) {
  // Staff/Clinical Director get the same dashboard, plus the header toolbar.
  loadStaffDashboard();
} else {
  // Clients get the calming, schedule-first dashboard.
  loadClientDashboard();
}
window.addEventListener('scroll', () => {
  document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 10);
});

// Handle ?join=<id> deep-link. Skip when an ?invite token is present — the
// invitation handler below owns that flow (OTP → open view → redeem → connect).
(function () {
  const params = new URLSearchParams(window.location.search);
  if (params.get('invite')) return;
  const joinId = parseInt(params.get('join'), 10);
  if (joinId) autoJoinMeeting(joinId);
})();

// Redeem a single-use invite token and connect. If the server reports the OTP
// clearance is missing/expired (NEEDS_OTP), prompt the per-session OTP and retry.
async function redeemInviteAndConnect(token, joinId, retried) {
  let data;
  try {
    data = await apiFetch('/teleconference/invite/redeem', {
      method: 'POST', body: JSON.stringify({ token }),
    });
  } catch (e) {
    BPSToast.error('Unable to process the invitation link.', { title: 'Invitation' });
    return;
  }
  if (data && data.code === 'NEEDS_OTP' && !retried && joinId) {
    const ok = await BPSTeleconfOtp.verify((BPSSession.getUser() || {}).email || '', joinId);
    if (ok) return redeemInviteAndConnect(token, joinId, true);
    return;
  }
  if (!data || !data.success) {
    BPSToast.error((data && data.message) || 'Unable to join via this invitation.', { title: 'Invitation' });
    return;
  }
  currentSession = data.data.session;
  // Legacy invite-only links carry no join id; open the session view now (using
  // the id from the redeem result) so the client lands INSIDE the session.
  if (!joinId && currentSession && currentSession.id) {
    const opened = await openSession(currentSession.id);
    if (opened === false) return;
  }
  await connectToRoom(data.data);
}

// Handle ?invite=<token> (optionally &join=<id>) single-use invitation deep-link.
// Enforced order for the client: (1) open the session view, which runs the
// per-session OTP gate, then (2) redeem the token (server re-checks OTP) and
// connect — so the client does OTP FIRST and is taken straight INTO the session.
(async function () {
  const params = new URLSearchParams(window.location.search);
  const rawToken = params.get('invite');
  if (!rawToken) return;
  const joinId = parseInt(params.get('join'), 10) || null;
  // Strip the params so a refresh can't re-redeem the consumed token.
  try { history.replaceState(null, '', window.location.pathname); } catch (_) {}

  if (joinId) {                                   // 1. open view → per-session OTP
    const opened = await openSession(joinId);
    if (opened === false) return;
  }
  await redeemInviteAndConnect(rawToken, joinId); // 2. redeem + connect
})();