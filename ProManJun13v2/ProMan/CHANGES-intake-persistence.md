# Changes — Intake persists only when paid (Option A)

Implements: "the intake form should only be stored once both the intake form and
payment are completed", while keeping the staff-review-first flow you asked for in the
previous step (intake → staff approves → client confirms → pay).

## How it works
The intake form + appointment are still written at submission so staff can review and
approve them, but they are now **provisional**: a booking only persists if it reaches a
**verified payment**. Bookings that won't get there are removed automatically, so the
intake forms that remain in the database are the ones that were completed and paid.

A new cleanup service removes a booking's intake form, appointment, and any
non-verified payments when:
- the appointment is **declined or cancelled**, or
- the appointment is **unpaid and its scheduled time has passed** (no-show / never paid).

Bookings that are **paid (verified)** or have a payment **in progress**
(`pending` / `under_review`) are never touched. Foreign keys are `ON DELETE SET NULL`,
so these deletes never break referential integrity.

## Where it runs
- `backend/services/intakeCleanup.js` — `purgeAppointment(id)` and `sweepUnpaidIntakes()`.
- `intakeController.getIntakeForms` and `appointmentController.getAppointments` run the
  sweep before listing (lazy, mirroring the existing expired-payment sweep).
- `appointmentController.clientDecline` purges the booking immediately on decline.

## Result
- A submitted-but-never-approved intake whose date passes unpaid → removed.
- A declined/cancelled booking → removed.
- A booking that completes payment (verified) → kept permanently.

## Note on interpretation
This is the practical reading of the requirement that's compatible with staff reviewing
intakes before charging: intakes are transient until paid and only *persist* once paid.
If you instead want a literal "no database row until payment" (payment before any staff
review), that's the express-checkout path — say the word and I'll switch to it.

`node_modules/` and the bundled `PostgreSQL/` folder are excluded; run `npm install` in
`backend/`.
