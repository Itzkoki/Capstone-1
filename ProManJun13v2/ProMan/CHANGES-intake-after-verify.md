# Changes — Intake form stored ONLY after payment is verified

This changes the intake logic exactly as requested: the client's intake form is now
written to the `intake_forms` table **only after staff have approved the schedule AND
verified the payment** — never at submission, and never just because the schedule was
confirmed.

## The problem this fixes
Previously, submitting the intake form immediately created an `intake_forms` row (and an
appointment). That was wrong — the intake should not be stored until the payment is
verified.

## How it works now
1. **Client submits the intake form** → NOTHING is written to `intake_forms`. The
   answers are held in a temporary review buffer on the appointment
   (`appointments.pending_intake_data`), and an appointment is created as
   `pending_review`. The client is notified it was submitted for review.
   *(A buffer is required because staff review/approve the schedule days before
   payment, so the answers must survive in between — but they are NOT in the official
   intake table.)*
2. **Staff review & approve the schedule** using the buffered answers (the staff
   submissions page now reads from the appointment, not from `intake_forms`).
3. **Client confirms and pays.**
4. **Staff verify the payment** → only now are the answers **promoted** into
   `intake_forms` (the official record), the appointment is linked to it, and the buffer
   is cleared.

If a booking is declined, cancelled, or never paid, it is swept away (existing cleanup)
and **no `intake_forms` row is ever created**.

## Files
- `backend/migrations.js` — adds `appointments.pending_intake_data` (JSONB buffer).
- `backend/models/Appointment.js` — `create()` can stage `pendingIntakeData`.
- `backend/controllers/intakeController.js` — `submitIntakeForm` no longer inserts into
  `intake_forms`; it stages the answers on the appointment.
- `backend/services/intakePromote.js` — `promoteIntakeForAppointment()` inserts the
  official `intake_forms` row from the buffer (idempotent).
- `backend/controllers/paymentController.js` — `verifyPayment` (approve) promotes the
  intake the moment payment is verified.
- `intake-submissions.html` — staff list is now driven by appointments; intake details
  come from the buffer (pending) or the promoted `intake_forms` row (verified).

## Notes
- The migration is guarded and applies on server start.
- The express-checkout path remains in the code but is unused by the UI.
- `node_modules/` and the bundled `PostgreSQL/` folder are excluded; run `npm install`
  in `backend/`.
