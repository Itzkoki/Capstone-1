# Feature — BPS Clients' Requests and Concerns

A complete ticketing module for clients/parents to formally submit requests and
concerns about released psychological assessment reports.

## Client side — `requests.html` (navbar: Services → Requests & Concerns)
- **Form fields:** Client name (Family / Given / M.I.), Parent/Guardian, Date of
  Assessment, Contact Number, Center & Branch.
- **Nature of request:** "Additional copies of reports" (fee applies) or "Concerns
  about the report" (free).
- **Concern checklist** (shown for report concerns): misspelled name, wrong
  birthday/age, wrong address, findings/diagnosis, recommendations, missing
  pages/documents, plus an "Other" open field.
- **Brief description** (required) and an **optional attachment** (JPG/PNG/PDF ≤5 MB).
- On submit, a unique ticket number is generated server-side
  (`BPS-REQ-YYYYMMDD-NNN`, daily sequence) and shown to the client; a confirmation
  notification is sent.
- **My Tickets** list with live status badges (Submitted / Under Review / Resolved /
  Closed), the staff member handling it, payment box (clinic QR + reference + proof
  upload) when payment is requested, the resolution note, a **View Finalized Report**
  button, and on resolution: **Acknowledge & Close** or **Not satisfied — flag for
  review** (which reopens the ticket and alerts staff).

## Staff side — `request-management.html` (navbar: Dashboard → Requests & Concerns)
- All tickets with filters (All / Submitted / Under Review / Resolved / Closed /
  Payments to Verify), client + form details, concern tags, attachment viewer.
- **Start Review**, **Send Payment Prompt** (additional-copy requests; ₱ fee, reference
  derived from the ticket), **Verify / Reject Payment** (rejection requires a reason and
  notifies the client to re-upload), **Assign / Deadline** (clinical director only;
  assigned staff is notified; overdue deadlines highlighted), **Resolve…** (resolution
  note required; optional corrected/additional report upload which is released to the
  client), **Close Ticket**, and a per-ticket reply thread.

## Workflow enforcement (backend)
- Resolution is blocked until payment is **verified** for paid requests; report release
  is likewise blocked until verified.
- Report files are accessible **only** by the owning client (and staff), and only after
  release.
- Status changes, payment events, and report release each notify the client in-system;
  new tickets/proofs/flags notify staff.

## Generated Reports (profile)
The profile's Generated Reports section now lists reports released from tickets
(`GET /api/requests/released-reports`) with download buttons; loads lazily.

## Audit log
Every action — submission, assignment, payment prompt, proof upload, verification /
rejection, status changes, report release, replies/flags — is written to the existing
`activity_logs` table with timestamps via `ActivityLog.log`.

## Backend
- Migration: `client_requests` + `client_request_replies` tables; `'request'` added to
  the allowed notification types.
- `backend/controllers/requestController.js`, `backend/routes/requests.js`, mounted at
  `/api/requests` in `server.js`.
- File handling mirrors the payments module (base64 data-URLs, JPG/PNG/PDF, ≤5 MB,
  blobs stripped from list payloads).

## Notes
- The additional-copy fee defaults to ₱1.00 (same placeholder scale as the existing
  appointment fees) — adjust `ADDITIONAL_COPY_FEE` in `requestController.js`.
- Assignment is restricted to the clinical director (the system's admin-equivalent
  role); other staff actions require psychometrician or above.
- Run `npm install` in `backend/`; migrations apply on server start. `node_modules/`
  and the bundled `PostgreSQL/` folder are excluded from the package.
