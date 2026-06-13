# Changes — Appointment Notification flow restored

This reverts the "express checkout" intake path and restores the staff-approval flow:
intake submitted for review → staff approves → client confirms → pay.

## Step 1 — "Submitted for review", then "proceed to payment" after approval
- Finishing the intake form now stores the intake form **and** its appointment
  immediately (so staff can review it), and notifies the client that their **intake
  form and appointment have been submitted for review** (staff are notified too). The
  client is taken to their notifications.
  - `intakeform.html` (submits to `POST /api/intake-forms` again; no more held/express
    redirect), `backend/controllers/intakeController.js` (client notification reworded).
- After a staff member approves the schedule, the client receives the **Appointment
  Approved** notification; confirming it leads to the **"Schedule Confirmed — Complete
  Payment"** (proceed-to-payment) notification. These already existed and are unchanged.

## Step 2 — Edit after confirm, before payment (kept)
A confirmed-but-unpaid appointment is still editable from **View Details → Edit
Appointment** (`canEdit` includes `confirmed && !isPaid`; backend edit guard blocks only
paid/closed). `notifications.html`, `appointmentController.js`.

## Step 3 — Reminder + agreement checkbox + Proceed to Payment (kept)
On a confirmed-unpaid appointment, the modal shows the no-refund / no-cancellation
reminder, a required agreement checkbox, and a disabled-until-checked **Proceed to
Payment** button. The agreement is stored in the DB (`payments.agreed_no_cancellation`,
1 = agreed / 0 = not) when the payment is created. `notifications.html`,
`backend/models/Payment.js`, `paymentController.js`.

## Step 4 — Payment page (kept)
Proceed to Payment opens `payment.html?appt=<id>`: two boxes for Half/Full, the 7-minute
timer (starts after choosing, shown large at the bottom), GCash QR, and proof upload.

## Notes
- The express intake→pay endpoints (`/api/intake-forms/checkout`, `/notify-payment`,
  `payment.html?flow=intake`) remain in the codebase but are no longer used by the UI;
  the intake form now always goes through the review/approval flow above. They can be
  removed later if desired.
- `node_modules/` and the bundled `PostgreSQL/` folder are excluded; run `npm install`
  in `backend/`.
