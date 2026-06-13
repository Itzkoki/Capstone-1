# v2 — Audit Log table + Report Requests feature

Builds on the v1 fixes (submission 500 + navbar icons, both still included).

## A. Database Fix — dedicated audit log for client requests

New append-only table `client_request_audit_logs` (separate from the global
`activity_logs`) records every action on a ticket with the responsible user, a
timestamp, and free-text remarks.

- Table: `id, request_id (FK→client_requests), user_id (FK→users), action,
  remarks, created_at` + indexes on `request_id` and `created_at`.
- Model: `backend/models/RequestAuditLog.js` — `log(requestId, userId, action,
  remarks)` (self-guarding, never throws) and `forRequest(requestId)` (full
  chronological trail joined to the user's name/role).
- Wired into the controller for: REQUEST_SUBMITTED, STAFF_NOTIFIED,
  PAYMENT_PROMPTED, REQUEST_APPROVED, REQUEST_REJECTED, PAYMENT_SUBMITTED,
  PAYMENT_APPROVED, PAYMENT_REJECTED, REPORT_GENERATED, REPORT_SENT.
- Endpoint: `GET /api/requests/:id/audit` returns the trail.
- Created automatically on startup (in `ensureRequestTables()`), and included in
  the standalone `backend/client_requests_schema.sql` for live databases.

## B. Report Requests (Report Module — Clinical Director)

A new **Report Requests** view in the Report Module (`psych-reports`), visible to
Clinical Directors, implementing the full review → payment → send lifecycle.

### Status model
A single derived display status computed from the existing columns:

    Under Review → Awaiting Payment → Payment Submitted → Payment Verified
                 → Resolved → Sent           (and Rejected at review)

Derivation lives in `reportRequestStatus(row)` in the controller and is returned
as `report_request_status` on every request payload.

### New columns on `client_requests`
`approved_at, approved_by, rejection_reason, payment_rejection_reason,
receipt_number, receipt_issued_at, sent_at, sent_by`; the `status` check
constraint now also allows `'rejected'`. All added idempotently.

### Backend endpoints (all Clinical-Director-gated)
- `GET  /api/requests/report-requests` — table feed (client name, reference,
  request type, date submitted, derived status).
- `PUT  /api/requests/:id/review` — `{action:'approve'|'reject', reason?, amount?}`.
  Approve → Awaiting Payment (reuses the existing payment workflow: sets
  `payment_required`, amount, reference, `payment_status='awaiting_payment'`),
  notifies the client to proceed to payment. Reject → requires a reason, sets
  `status='rejected'`, notifies the client with the reason.
- `PUT  /api/requests/:id/payment-verify` — now CD-only. Approve → Payment
  Verified, **generates a receipt** (`<ticket>-RCPT`) and notifies the client the
  receipt is available. Reject → requires a reason, stores it, and notifies the
  client to **re-upload** (link `requests.html?reupload=<id>`).
- `POST /api/requests/:id/send` — only when Resolved. Sets `sent_at`/`sent_by`,
  delivers the report to the client's Generated Reports, and notifies the client
  with a link to open it (`profile.html?view=generated-reports&report=<id>`).

### Resolution & access rules
- Uploading the report (`POST /:id/report`) now marks the request **Resolved**
  (report generated) rather than delivering it; delivery is the separate Send step.
- Business rule enforced: clients cannot access the report until **Sent**
  (`GET /:id/file?type=report` requires `sent_at`; Generated Reports lists only
  sent reports; the client "View Finalized Report" button shows only once Sent).

### Frontend (`psych-reports.html` / `psych-reports.js`)
- Sidebar nav item "Report Requests" (with an open-count badge) in the Director
  section; new `#view-reportRequests` table (Client Name, Reference Number,
  Request Type, Date Submitted, Status, Actions).
- Actions are context-aware: **Review** (request form + Approve/Reject) while
  Under Review; **Verify Payment** (client info, request info, payment details,
  uploaded proof + Approve/Reject Payment) while Payment Submitted; **Send** when
  Resolved; read-only **View** otherwise. Reject actions require a reason.
- Reuses the module's existing `api()`, `toast()`, `openModal/closeModal`,
  loading overlay, and table/modal styles.

## Verification
The full backend lifecycle was exercised against a live PostgreSQL instance:
submit → approve → proof → payment reject → re-upload → payment approve (+receipt)
→ report generated (Resolved) → send (Sent), plus a rejected request. Every
derived status, the Send gating, Generated Reports filtering, and the complete
audit trail (all spec actions, each with user + timestamp + remarks) passed.

## Notes / remaining polish (frontend-only, backend ready)
- Notification deep-links are emitted by the backend. Auto-opening the report on
  `profile.html?view=generated-reports&report=<id>` and auto-focusing the
  re-upload box on `requests.html?reupload=<id>` are small client-side handlers
  not yet added; the report still appears in Generated Reports and re-upload is
  already allowed once a payment is rejected.
- Per the spec, payment verification is Clinical-Director-only; the older
  `request-management.html` staff console will get 403 on payment-verify for
  non-CD roles.

## Files in this bundle
- `backend/migrations.js`, `backend/client_requests_schema.sql`
- `backend/models/RequestAuditLog.js` (new)
- `backend/controllers/requestController.js`, `backend/routes/requests.js`
- `psych-reports.html`, `psych-reports.js`
- `requests.html`, `request-management.html` (also carry the v1 navbar fix)
- `CHANGES-requests-fix-navbar.md` (v1), `CHANGES-report-requests.md` (this file)
