# Changes — June 10

Two changes in this revision: a client-side **payment transaction history** in the
profile tab, and a **notification de-stacking** fix so opening an appointment
notification shows only the relevant appointment.

## 1. Payment Transaction History (client side, Profile tab)

A new **Transaction History** section was added to the client profile page. It lists
every payment the signed-in client has made, newest first, using the existing
`GET /api/payments` endpoint (clients only ever receive their own records, and the
proof-of-payment blob is stripped server-side for the list).

Each row shows the system reference number, the date submitted, the payment type
(Full / Half) and method, the amount, and a status badge. For **half** payments any
remaining balance due in person is shown under the amount. **Verified** payments link
to the printable receipt (`receipt.html?payment=<id>`).

Statuses map to badges: Awaiting Payment (pending), Under Review (under_review),
Verified (verified), Rejected (rejected), Expired (expired).

The list loads lazily the first time the tab is opened; a load failure shows an error
and allows a retry on the next open.

### Files
- `profile.html` — new sidebar link + `#section-transactions` markup + `loadTransactions()`
  loader/renderer; lazy-loaded from the section switcher.
- `profile.css` — `.txn-*` styles (table, status badges, receipt button, mobile rules).

No backend changes were needed — the payments API already supports client listing.

## 2. Notification changes — don't stack appointments

Previously, clicking any appointment notification opened a modal that fetched and
rendered **all** of the user's appointments stacked together. Now the modal shows only
the appointment that the notification is about. This applies to both **client** and
**staff**, which share the same modal.

To do this, appointment notifications now carry the related appointment id in their
link (`notifications.html?appt=<id>`). The notifications page parses that id and scopes
the detail modal to that single appointment. When a notification has no id (e.g. an
older one created before this change), the modal falls back to showing only the single
**current** appointment — the most recent non-terminal one — rather than the full list,
so previous appointments are never stacked.

The modal also remembers which appointment it is showing, so in-modal actions
(Confirm, Pay, Edit, Accept/Decline) refresh the same appointment instead of reverting
to the list. The tracked id resets when the modal is closed.

### Files
- `backend/controllers/appointmentController.js` — all appointment notification links
  now embed `notifications.html?appt=<id>` (client- and staff-facing).
- `notifications.html` — parse `apptId` from the link; `handleAction` passes it to
  `showAppointmentModal(apptId)`; the modal scopes to one appointment with a
  current-appointment fallback (`pickCurrentAppointment`); `currentApptId` tracking +
  reset on close (× button and overlay click).

## Notes
- `node_modules/` is not included in this package — run `npm install` in `backend/`
  to restore dependencies.
