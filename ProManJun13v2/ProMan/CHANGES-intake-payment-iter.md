# Changes — Intake/Payment refinements

## 1. Payment procedures back in the notification
After the client finishes the intake form, the app no longer jumps straight to the
payment page. Instead it drops a **"Complete Your Payment"** notification (via
`POST /api/intake-forms/notify-payment`) and sends the client to their notifications.
Opening that notification starts the payment procedure (`payment.html?flow=intake`).
The intake is still held in the browser and is not stored in the database yet.
- `intakeform.html` (creates the notification, routes to notifications.html),
  `backend/controllers/intakeController.js` (`notifyPaymentPending`), route,
  `notifications.html` ("Complete Payment" action label).

## 2. Two boxes for Half / Full (no more "change my mind")
The "Change my mind" button on the QR screen was removed. The two option boxes
(**Half** / **Full**) are now shown in both the choose state and the pay state. The
selected box is highlighted; tapping the other box switches the option (server-side via
`PUT /api/payments/:id/option`) right up until proof is uploaded.
- `payment.html` (`optionBoxesHtml`, `selectOption`), styles for `.opt-card--selected`.

## 3. Timer starts only after choosing; shown at the bottom, large
The expiration timer no longer runs on page load. It starts only once the client picks
Half or Full (i.e. once a payment exists) and is rendered at the **bottom** of the pay
box in a large, clearly readable countdown (with a low-time red/pulse state).
- `payment.html` (timer anchored to the payment's expiry; `timerBannerHtml` at the
  bottom of the pay box), timer styles.

## 4. 7-minute window → redo intake on expiry
Both payment flows now use a 7-minute server-side hold, and the visible timer counts
down to it. When it hits zero the unpaid checkout is rolled back and the intake-flow
client is sent back to the intake form to start again.
- `backend/controllers/paymentController.js` (appointment-flow hold = 7 min),
  `payment.html` (`onExpire`).

## 5. Intake stored only after intake + payment (unchanged behaviour, kept)
The intake form is still held in the browser and only persisted — together with the
appointment and payment — at checkout (`POST /api/intake-forms/checkout`). If the
7-minute window lapses without proof, `DELETE /api/intake-forms/checkout/:paymentId`
removes the intake, appointment, and payment so nothing remains stored for an unpaid
checkout.

## Notes
- The "Complete Your Payment" notification opens the payment page, which reads the
  held intake from the browser session. If that data is gone (e.g. a new session), the
  page invites the client to fill out the intake form again — consistent with the
  redo-on-expiry rule.
- `node_modules/` and the bundled `PostgreSQL/` folder remain excluded; run
  `npm install` in `backend/`. Migrations apply on server start.
