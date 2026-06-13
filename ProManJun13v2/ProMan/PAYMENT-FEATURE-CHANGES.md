# Appointment Scheduling & Payment — Two-Phase Flow

Payment now happens **after** a schedule is mutually agreed, not at intake. Appointments
can no longer be cancelled (strict no-refund / no-cancellation policy), and a printable
**receipt** is available once a payment is verified.

## Phase 1 — Intake & Schedule Proposal
1. Client fills out the intake form and submits a preferred schedule (no payment here).
2. Staff reviews the form and checks availability (intake-submissions.html).
3. If available → staff **approves**, and the client gets a booking-confirmation prompt
   (notifications → appointment → **Confirm Booking**).
4. If unavailable → staff **proposes an alternative**; the client can **Accept**,
   **Propose a different time**, or **Decline**. This continues until both agree.
5. When the client confirms, the appointment becomes **confirmed**.

## Phase 2 — Payment (only after the schedule is confirmed)
1. On the confirmed appointment, the client chooses **Half (₱1)** or **Full (₱2)**.
2. The system issues a unique reference (BPS-YYYYMMDD-NNNN) and shows the static GCash QR,
   exact amount, and a 24-hour window.
3. The client scans, pays, and uploads proof (JPG/PNG/PDF, ≤5 MB) → status **Under Review**.
4. Staff verifies in **Payment Verification** (payments-admin.html).
5. On verification the slot is officially reserved and the client is notified
   **"Payment Verified — Slot Confirmed"**. Clicking **View** opens the **receipt**.

## What changed in this revision
- **Removed** the payment step from the end of the intake form (reverted to 7 steps; the
  form submits normally and tells the client payment follows schedule confirmation).
- **Removed** the cancel-appointment option for both clients and staff: the client cancel
  buttons/handlers in `notifications.html` are gone, and the `PUT /api/appointments/:id/cancel`
  route is removed. Appointments can still be **edited/rescheduled** only during negotiation
  (pending_review / approved / reschedule_proposed), never cancelled.
- **Payment moved** into the confirmed-appointment view in `notifications.html` (option select →
  QR + reference → proof upload), gated server-side so a payment can only be created for an
  appointment in `approved`/`confirmed` status, with duplicate-payment protection.
- **Failed payments no longer cancel the appointment.** An expired or rejected payment just
  sets `appointments.payment_status` to expired/rejected and lets the client submit a new
  payment — the agreed slot is kept.
- **Receipt added** (`receipt.html?payment=<id>`): a printable official receipt shown when the
  client opens the "Payment Verified — Slot Confirmed" notification.

## Files
### New
- `receipt.html` — printable client payment receipt (shown after verification).
- `backend/models/Payment.js`, `backend/controllers/paymentController.js`,
  `backend/routes/payments.js` — payment API.
- `payments-admin.html` — staff verification console.
- `qr-full-payment.jpg`, `qr-half-payment.jpg` — clinic static QR images.

### Modified
- `intakeform.html`, `intakeform.css` — payment step removed; intake reverted to 7 steps.
- `notifications.html` — cancel removed; Confirm Booking on approved; payment widget on
  confirmed; receipt link on verified.
- `backend/controllers/appointmentController.js` — confirm now prompts the client to pay.
- `backend/routes/appointments.js` — cancel route removed.
- `backend/migrations.js`, `backend/server.js`, `backend/controllers/dashboardController.js`,
  `navbar.js` — payment table/column, route mount, staff entry points.

## Config
Fees / QR mapping live in `PAYMENT_CONFIG` at the top of `paymentController.js`
(totalFee 2.00, full 2.00, half 1.00, GCash). Adjust to match the clinic's real fees.

## Security / compliance (unchanged)
Server-generated immutable references; proof validated by type/size and stored for staff only;
admin approve/reject logged to `activity_logs`; no card/wallet/banking credentials stored.
