# Changes — June 10 (Appointment Scheduling & Payment enhancement)

Three related changes to the payment flow.

## 1. No-refund / no-cancellation agreement + checkbox (stored in DB)

Before a client can pay, the appointment detail modal (`notifications.html`) now shows
a **reminder** that payments are non-refundable, appointments are non-cancellable, and
the scheduled date/time can no longer be changed once paid — followed by a required
**agreement checkbox** and a **Proceed to Payment** button (disabled until the box is
ticked).

The agreement is stored in the database. A new column was added to the `payments`
table: `agreed_no_cancellation SMALLINT NOT NULL DEFAULT 0` — **1 = agreed, 0 = not**.
When a payment is created, the server requires the acknowledgement and records `1`. A
payment cannot be created without it (the API rejects the request otherwise).

### Files
- `backend/migrations.js` — adds `agreed_no_cancellation` to `payments` (1/0, default 0).
- `backend/models/Payment.js` — `create()` accepts and inserts the flag.
- `backend/controllers/paymentController.js` — `createPayment` requires `agreed` and
  stores it (rejects with 400 if not agreed).
- `notifications.html` — reminder + checkbox + Proceed to Payment in the appointment
  modal (replaces the old inline option buttons).

## 2. Dedicated payment page

After **Proceed to Payment**, the client now goes to a new standalone page,
**`payment.html?appt=<id>`**, instead of paying inside the notification modal. The page:

- shows the appointment summary and the non-refundable/non-cancellable reminder;
- lets the client choose **Half** or **Full** payment, which creates the payment
  (sending the agreement) and shows the GCash QR, reference number, exact amount, and a
  proof-of-payment upload;
- resumes an in-progress (pending) payment, and shows Under Review / Verified states
  with a link to the receipt.

The old in-modal payment widget is no longer used; the modal now links out to this page
(including a "Continue Payment" link for a pending payment).

### Files
- `payment.html` — **new** dedicated payment page (matches the existing app styling,
  same auth/session/navbar conventions as `receipt.html`).
- `notifications.html` — modal links to `payment.html` instead of paying inline.

## 3. Slots reserved only after successful payment

Appointment time slots are now reserved **only after the client has successfully paid**
(payment verified by staff → `appointments.payment_status = 'paid_verified'`).
Previously a slot was occupied from the moment an appointment was created/approved,
regardless of payment.

`Appointment.getBookedSlots()` and `Appointment.countByDate()` now count a slot as taken
only when the appointment is non-terminal **and** `payment_status = 'paid_verified'`.
These two functions back every availability check (intake submission, reschedule/edit,
the `/api/appointments/availability` endpoint), so an unpaid appointment no longer
blocks the slot for anyone. Creating a payment no longer holds the slot — only
verification reserves it.

### Files
- `backend/models/Appointment.js` — `getBookedSlots` / `countByDate` gated on
  `payment_status = 'paid_verified'`.
- `backend/controllers/paymentController.js` — clarified that creating a payment does
  not reserve the slot.

## Notes & trade-offs
- Because slots are now payment-gated, two clients can hold the same preferred time
  while both are unpaid; the slot locks for whoever pays (and is verified) first. Staff
  still get an overlap warning at approval time (`checkConflict`). This is the direct
  consequence of "slots only update after successful payment."
- The agreement is recorded on each created payment. Since payment can't be created
  without agreeing, stored values are `1`; the column default `0` represents "not
  agreed."
- Run the server once to apply the migration (`ADD COLUMN IF NOT EXISTS`), and
  `npm install` in `backend/` to restore dependencies (not included in the package).
