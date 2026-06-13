# Changes — Payment rejection re-submission & intake form DB update

## 1. Payment rejection → resend proof (with bold reason)
When staff reject a payment proof, the client now gets a **"Payment Could Not Be
Verified"** notification (action: **Complete Payment**) that links straight to the
payment page. Opening it shows a **resend** screen for the same payment:
- the rejection reason is shown in **bold** ("Reason: **…**") so it's easy to see;
- the client uploads a new screenshot and submits it (the payment goes back to
  *under review*);
- no payment timer and no option boxes on a resubmission — they already paid, they're
  only resending proof.

Files: `backend/controllers/paymentController.js` (reject notification → payment page;
upload accepts a rejected payment), `backend/models/Payment.js` (`attachProof` allows
`pending`/`rejected` and clears the old reason), `payment.html` (rejected → resend box
with bold reason), styles.

## 2. Intake persists only after approval + verified payment
The intake form record only **persists** once the appointment has been approved by
staff and the payment is **verified** — this is the provisional-then-cleanup rule from
the previous step: a booking that never reaches a verified payment (declined, cancelled,
or unpaid past its date) has its intake form, appointment, and non-verified payments
removed. A verified payment necessarily means the schedule was approved and confirmed,
so "approved + verified payment" is the persistence trigger. (No new code needed beyond
the existing cleanup service.)

## 3. Removed intake-form approve/reject + dropped the status column
The intake form no longer has its own staff approve/reject validation. Staff still
approve the **appointment schedule** (Approve Schedule / Propose New Time) — that is the
approval that matters — but the intake form itself has no status.
- **Database:** `intake_forms.status` column and its index are dropped
  (`backend/migrations.js`).
- **Backend:** `status` removed from intake inserts, queries, and responses; the
  `PUT /api/intake-forms/:id/status` endpoint and its route were removed
  (`intakeController.js`, `routes/intake.js`).
- **Staff page (`intake-submissions.html`):** the intake Mark Reviewed / Approve /
  Reject buttons and the intake status badge are gone; the filter bar and the "pending"
  badge now reflect **appointment** status (All / Pending Review / Approved / Confirmed);
  the detail modal no longer shows an intake status.

## Notes
- The migration is guarded (`DROP COLUMN IF EXISTS`) and applies on server start.
- A few now-unused `.status--*` CSS classes remain in the staff page (harmless; still
  used for appointment statuses).
- `node_modules/` and the bundled `PostgreSQL/` folder are excluded; run `npm install`
  in `backend/`.
