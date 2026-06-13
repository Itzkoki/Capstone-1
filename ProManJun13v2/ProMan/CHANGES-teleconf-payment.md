# Changes — Teleconference Module + Appointment/Payment

## Teleconference Module

### 1. "Not in the Meeting" section (no auto waiting room)
Invited participants are now provisioned with a new `invited` admit status instead of
`waiting`, so creating a session no longer drops everyone into the waiting room. The
People panel's section is now **"Not in the Meeting"** and lists participants whose
status is `invited`. When a participant actually tries to enter (Join Session), the
existing join logic flips them to `waiting`, where the host approves them before they
enter.
- `backend/migrations.js` — `admit_status` CHECK now allows `invited`.
- `backend/controllers/teleconferenceController.js` — client + staff added as `invited`.
- `meetings.html` — section relabelled; filter is `admit_status === 'invited'`; the
  "In this meeting" list now requires `joined_at && admit_status === 'admitted'`.

### 2. Rejoin reappears as an active participant
Added `markLeft` (clears `joined_at`, keeps `admitted`) + `POST /:id/leave`. `leaveSession`
and a `beforeunload` handler notify the server on leave, so the person drops out of the
roster; rejoining re-sets `joined_at` (no re-approval) and they show as active again.
- `backend/models/TeleconferenceSession.js`, `teleconferenceController.js`, routes,
  `meetings.html`.

### 3. Camera-off placeholder
Each video tile renders an avatar disc with the participant's initial, shown via CSS
whenever the tile is in the `--camoff` state, instead of a black screen.
- `meetings.html` (tile markup), `meetings.css`.

### 4. Real-time voice activity detection
A Web Audio `AnalyserNode`-based detector runs on every participant's mic (local +
remote, via `track.mediaStreamTrack`), computing RMS with hysteresis. The active
speaker gets a green ring on their video tile and People-panel card in real time; it
clears when they stop. Local detection is gated on the mic being enabled.
- `meetings.html` (VAD module), `meetings.css` (`--speaking` styles).

## Appointment / Payment

### 5. Edit after confirm, before payment
A confirmed appointment is now editable as long as it has not been paid
(`payment_status !== 'paid_verified'`), both in the notifications modal and the backend
edit guard. A verified payment locks the schedule.
- `notifications.html`, `backend/controllers/appointmentController.js`.

### 6. Half/Full options on the payment page + change of mind
The payment page keeps both Half/Full options, and once a (pending, no-proof) payment
exists the client can switch via a new `PUT /api/payments/:id/option` endpoint
("Change my mind" control).
- `backend/models/Payment.js`, `paymentController.js`, routes, `payment.html`.

### 7. 7-minute payment-page expiration timer
The payment page shows a 7-minute countdown. On expiry it rolls back any unpaid express
checkout and, for the intake flow, sends the client back to the **intake form to start
again** (appointment-flow expiry returns to notifications). The express checkout's
server-side payment hold is also set to 7 minutes.
- `payment.html`, `backend/models/Payment.js` (configurable expiry), `intakeController.js`.

### 8. Intake stored only after intake + payment
The intake form is no longer written to the database when the client finishes the form.
Instead it is held in the browser and the client is taken to the payment page. The
intake form, appointment, and payment are created together only when the client commits
to payment (`POST /api/intake-forms/checkout`). If the 7-minute window expires before
proof is uploaded, `DELETE /api/intake-forms/checkout/:paymentId` rolls back the intake,
appointment, and payment so nothing remains stored for an unpaid checkout.
- `intakeform.html` (defers submit → holds data → `payment.html?flow=intake`),
  `backend/controllers/intakeController.js` (`checkoutIntake`, `abandonCheckout`),
  routes, `payment.html` (intake flow).

## Design note on reqs 5 vs 7/8
Reqs 7–8 (intake → pay in one 7-minute session) and req 5 (edit a confirmed-but-unpaid
appointment) describe different payment-timing models. They coexist coherently here:
- **Express path (new clients):** intake → pay deposit immediately → staff approves →
  client confirms (already paid, no second prompt).
- **Appointment path:** an unpaid confirmed appointment can still be edited (req 5) and
  paid with Half/Full options (req 6) via the same payment page.
The payment section in the confirmed-appointment view only shows the pay gate when the
appointment is genuinely unpaid, so an express-paid client is never asked to pay twice.

## Notes
- Migrations are `IF NOT EXISTS` / guarded, applied on server start.
- `node_modules/` and the bundled `PostgreSQL/` folder are excluded from the package;
  run `npm install` in `backend/`.
