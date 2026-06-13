# Update Summary — Jun 8

## Intake Form
- **Data Privacy Act consent moved to the start.** After a client picks their
  service/assessment type, a Data Privacy Act (RA 10173) consent screen now
  appears *before* Step 1. They must tick the agreement box to enable
  "I Agree & Continue" before the form opens.
- **Removed the end-of-form acknowledgment box** on the Review & Submit step.
  The submit button is enabled normally; submission is guarded by the
  start-of-form consent.
- **Stored in the database.** New column `intake_forms.data_privacy_consent`
  (BOOLEAN). It is saved on submit, returned by the API, and shown in the staff
  view (`intake-submissions.html` → detail modal → "Consent" section).
- **Radio buttons aligned.** All `.radio-option` controls now have the dot and
  label correctly centred with consistent spacing (`intakeform.css`).

## Teleconference
- **Staff chosen from a dropdown (no typing).** The "Assign Additional Staff"
  control now mirrors the client picker: pick from a dropdown, press **Add**,
  and each choice appears as a removable chip. Still capped at **3** staff.
- **Per-meeting ID + per-participant password.** Each session gets a readable
  Meeting ID (e.g. `BPS-7G2KQ9`). Every participant (host, client, each staff)
  gets their **own unique password**. A participant's password is shown to them
  in the **Session Info** panel ("Your Password"), and that password is
  **required** when they click Join.
- **Waiting Room.** Non-host participants enter a waiting room after their
  password is verified. The host sees a live "Waiting Room" panel and can
  **Admit** or **Deny**. Admitted participants connect automatically.
- **Host-only end.** Only the host (session creator) can end the session — both
  in the UI (End button hidden for others) and enforced on the server.
- **Real-time recording consent.** When the host requests a recording, the
  client gets a live pop-up explaining the recording is confidential, with
  **Approve / Reject**. The decision is stored in
  `teleconference_sessions.recording_response` as **1 (approved)** or
  **0 (rejected)** (NULL = no response yet).

### Database / migration notes
Schema changes are applied automatically on server start (`migrations.js`,
idempotent `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`):
- `intake_forms.data_privacy_consent BOOLEAN`
- `teleconference_sessions.meeting_code VARCHAR(20)`
- `teleconference_sessions.recording_response SMALLINT`  (1 / 0 / NULL)
- new table `session_participants` (per-participant password + admit status)

"Real-time" features (waiting room + recording pop-up) use ~4s polling, since
the app has no WebSocket/SSE layer.

---

## Update 2 — Teleconference flow

- **Automatic password + "meeting started" notification.** When the host
  creates a meeting, every invited participant (client + added staff) is sent a
  single notification: **"Your scheduled meeting has started."** Clicking it
  opens a **Join Meeting** pop-up showing that participant's own password and a
  **Join Meeting** button.
- **Direct join to the specific meeting.** The notification link is
  `meetings.html?join=<sessionId>`. Clicking **Join Meeting** takes the
  participant straight into *that* meeting (auto-joins with their password) —
  not the teleconference schedule, and with no intermediate session pop-up.
- **Old teleconference notifications removed.** All previous teleconference
  notifications (session created, waiting-room, admit/deny, recording
  request/decision, assignment) are gone. The waiting room and recording-consent
  pop-up still work via in-app polling. The list-style "Teleconference Session"
  modal in Notifications was replaced by the single-meeting Join pop-up.
- **Session Info hidden for clients.** Clients no longer see the Session Info
  panel (Meeting ID, password, etc.) in the meeting view.
- **Maximized, adaptive video.** In a live call the video area maximizes
  (full-width, tall) and the grid column count adapts to how many participants
  have joined (1 / 2 / 3 columns).
- **Invite-only visibility.** Only invited participants (host, client, added
  staff) can see a meeting. Non-invited users — including other staff — see no
  schedule at all. Enforced in `getAllSessions` (membership-based) and on direct
  access (`getSession` returns 403 for non-participants).

---

## Update 3 — Teleconference (chat, no passwords, Discord-style video)

- **In-meeting chat with timestamps.** New `session_messages` table + endpoints
  (`GET/POST /api/teleconference/:id/messages`). A chat panel in the meeting
  shows each message with the sender and a HH:MM timestamp; messages poll in
  real time (~4s) and auto-scroll.
- **Passwords removed.** No password to join and no password shown in Session
  Info; the join-password modal and the password row are gone. The
  `session_participants.access_password` column is now optional (kept for
  history; unused).
- **Session Info restored for clients.** Clients see the Session Info panel
  again (now without any password field).
- **See admitted participants before joining.** The Participants panel lists the
  people the host has admitted (with a green dot for those currently connected),
  visible before clicking Join.
- **Role labels.** Participants and the waiting room now show Host / Client /
  Staff badges.
- **Logs are host-only.** The Session Logs panel shows only for the host;
  removed for other staff (enforced on the server too).
- **Discord/Meet/Teams video layout.** A reusable `updateVideoGridLayout()`
  sets `data-count` on the grid; CSS produces: 1 = single large, 2 = two
  columns, 3 = two-on-top + one centred, 4 = 2×2, 5 = three-on-top + two centred
  (6+ falls back to 3×2). Tiles use width/height 100% + object-fit: cover, the
  grid fills the meeting area with no scrollbars, and tiles transition smoothly
  as people join/leave.
- **Strict invite-only access.** Opening a meeting by direct id now also
  requires being an invited participant (previously any staff could open it).

---

## Update 4 — Chat gating + MS Teams meeting nav

- **Chat only after joining.** The chat panel stays hidden in the session detail
  view and only appears once the participant has actually joined the meeting
  (connected). Chat polling is also gated on being in the call. It hides again
  on leave.
- **MS Teams-style meeting rail.** While in a meeting, a vertical Teams-style
  nav rail appears on the left with our system's own sections (role-based):
  clients see Home, Intake, Meetings, Community, Alerts, Profile; staff see
  Dashboard, Articles, Meetings, Intake, Community, Alerts, Profile. The current
  section (Meetings) is highlighted with the Teams-style accent bar. The rail
  shows only during the meeting and the content shifts right so nothing overlaps.
