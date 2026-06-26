# Clinic Management System — Case-Centered Architecture
### Specification v2.0

---

## Design Philosophy

Design and implement a clinic management system using a **Case-Centered Architecture**. Every clinical process — intake, payment, appointment, assessment, report, and release — must revolve around a **Case ID**. The **User ID** represents the client's permanent identity across all visits and must never be used as a clinical workflow identifier.

Core goals:

- Eliminate workflow confusion when a client undergoes multiple assessment episodes.
- Maintain complete traceability from intake submission to report release.
- Automate status transitions, notifications, and report ownership resolution.
- Enforce role-based access control at every workflow step.
- Preserve full audit history without destructive operations.

---

## Core Identifiers

### 1. User Identifier — Permanent Account Identity

Generated once on account creation. Never changes. Used only for authentication and linking a person to their cases.

```
Format:  USR-000145
```

```
users
├── user_id        PK
├── email          UNIQUE NOT NULL
├── password_hash  NOT NULL
├── full_name      NOT NULL
├── contact_number
├── created_at     DEFAULT CURRENT_TIMESTAMP
└── updated_at
```

Relationship: `One User → Many Cases`

---

### 2. Case Identifier — Episode-Based Clinical Identifier

A new Case is created every time a client submits an intake form. The Case ID becomes the single source of truth for all clinical processes within that assessment episode.

```
Format:  CASE-2026-00001
         CASE-2026-00002
         CASE-2027-00001
```

Rules:

- Auto-generated immediately upon successful intake submission.
- Unique, immutable, and never reused.
- Year-scoped with a zero-padded sequence.
- All records — payments, appointments, assessments, reports — reference the Case ID.

Relationship:
```
One User → Many Cases
One Case → One Assessment Episode
One Case → Many Payments
One Case → Many Appointments
One Case → Many Reports
One Case → Many Notifications
```

---

## Role-Based Access Control (RBAC)

### Roles

```
staff.role values:
  Psychologist
  Psychometrician
  Supervising Psychometrician
  Clinical Director
  Administrator
```

Clients are identified by the `users` table and hold no staff role.

### Permission Matrix

| Action                          | Client | Psychologist     | Psychometrician | Sup. Psychometrician | Clinical Director | Administrator |
|---------------------------------|--------|------------------|-----------------|----------------------|-------------------|---------------|
| Submit intake form              | ✅     | ❌               | ❌              | ❌                   | ❌                | ❌            |
| View own cases and reports      | ✅     | ❌               | ❌              | ❌                   | ❌                | ❌            |
| Review and approve intake       | ❌     | ✅ (assigned)    | ❌              | ❌                   | ✅                | ✅            |
| Reject intake with reason       | ❌     | ✅ (assigned)    | ❌              | ❌                   | ✅                | ✅            |
| Verify initial payment          | ❌     | ❌               | ❌              | ✅                   | ✅                | ✅            |
| Schedule appointment            | ❌     | ✅ (assigned)    | ❌              | ❌                   | ✅                | ✅            |
| Mark assessment in progress     | ❌     | ✅ (assigned)    | ✅ (assigned)   | ❌                   | ✅                | ❌            |
| Mark assessment complete        | ❌     | ✅ (assigned)    | ❌              | ❌                   | ✅                | ❌            |
| Draft and upload report         | ❌     | ✅ (assigned)    | ✅ (assigned)   | ✅                   | ✅                | ❌            |
| Submit report for approval      | ❌     | ✅ (assigned)    | ❌              | ❌                   | ❌                | ❌            |
| Approve or reject report        | ❌     | ❌               | ❌              | ❌                   | ✅                | ❌            |
| Review report request           | ❌     | ✅ (assigned)    | ❌              | ❌                   | ✅                | ✅            |
| Verify report request payment   | ❌     | ❌               | ❌              | ✅                   | ✅                | ✅            |
| Release report                  | ❌     | ✅ (assigned)    | ❌              | ❌                   | ✅                | ❌            |
| Close a case                    | ❌     | ❌               | ❌              | ❌                   | ✅                | ✅            |
| View all cases                  | ❌     | ❌               | ❌              | ✅                   | ✅                | ✅            |
| Manage staff accounts           | ❌     | ❌               | ❌              | ❌                   | ❌                | ✅            |
| View audit logs                 | ❌     | ❌               | ❌              | ❌                   | ✅                | ✅            |

"Assigned" means the staff member must be the `assigned_psychologist_id` on the case to perform that action. Clinical Director and Administrator can act on any case.

---

## Database Schema

### `users`

```
user_id          PK
email            UNIQUE NOT NULL
password_hash    NOT NULL
full_name        NOT NULL
contact_number
created_at       DEFAULT CURRENT_TIMESTAMP
updated_at
```

---

### `staff`

```
staff_id         PK
full_name        NOT NULL
role             ENUM('Psychologist','Psychometrician','Supervising Psychometrician','Clinical Director','Administrator')
email            UNIQUE NOT NULL
password_hash    NOT NULL
status           ENUM('Active','Inactive') DEFAULT 'Active'
created_at
updated_at
```

---

### `cases`

```
case_id                  PK  (format: CASE-YYYY-NNNNN)
user_id                  FK → users.user_id        NOT NULL
assigned_psychologist_id FK → staff.staff_id       NOT NULL
intake_date              DATE NOT NULL
status                   ENUM (see Case Status Lifecycle)
resubmission_count       INT DEFAULT 0  -- incremented each time a new case is created after rejection
created_at               DEFAULT CURRENT_TIMESTAMP
updated_at
closed_at                NULLABLE
```

Note: `assigned_psychologist_id` is set at intake submission. An Administrator or Clinical Director may reassign it before the case reaches `Scheduled` status.

---

### `intake_forms`

```
intake_form_id   PK
case_id          FK → cases.case_id   NOT NULL
form_data        JSON NOT NULL
submitted_at     DEFAULT CURRENT_TIMESTAMP
reviewed_by      FK → staff.staff_id  NULLABLE
reviewed_at      NULLABLE
review_status    ENUM('Pending','Approved','Rejected') DEFAULT 'Pending'
```

Note: Rejection reason is stored in `case_notes` with `note_type = 'IntakeRejection'`.

---

### `case_notes`  *(New)*

Stores all structured comments that accompany workflow decisions — intake rejections, report revision requests, appointment notes, and general clinical remarks.

```
note_id          PK
case_id          FK → cases.case_id   NOT NULL
author_staff_id  FK → staff.staff_id  NULLABLE
author_user_id   FK → users.user_id   NULLABLE
note_type        ENUM('IntakeRejection','ReportRevision','AppointmentNote','ReportRequestNote','General')
content          TEXT NOT NULL
is_visible_to_client  BOOLEAN DEFAULT FALSE
created_at       DEFAULT CURRENT_TIMESTAMP
```

Constraint: Exactly one of `author_staff_id` or `author_user_id` must be non-null.

---

### `psychologist_availability`  *(New)*

Required for validating appointment scheduling against a psychologist's actual availability.

```
availability_id  PK
psychologist_id  FK → staff.staff_id  NOT NULL
day_of_week      INT  (0 = Sunday, 6 = Saturday)
start_time       TIME NOT NULL
end_time         TIME NOT NULL
is_available     BOOLEAN DEFAULT TRUE
effective_from   DATE NOT NULL
effective_until  DATE NULLABLE  (NULL = indefinite)
```

Constraint: No overlapping availability windows for the same psychologist on the same day.

---

### `notifications`

```
notification_id     PK
recipient_staff_id  FK → staff.staff_id  NULLABLE
recipient_user_id   FK → users.user_id   NULLABLE
case_id             FK → cases.case_id   NOT NULL
type                ENUM (see Notification Catalog)
title               VARCHAR(255) NOT NULL
message             TEXT NOT NULL
action_url          VARCHAR(500) NULLABLE
is_read             BOOLEAN DEFAULT FALSE
created_at          DEFAULT CURRENT_TIMESTAMP
```

Constraint: Exactly one of `recipient_staff_id` or `recipient_user_id` must be non-null.

The `action_url` field enables deep linking in the frontend (e.g., `/cases/CASE-2026-00001/report`). The schema is compatible with future real-time delivery via WebSockets — just broadcast on the `notification_id` after INSERT.

---

### `payments`

```
payment_id              PK
case_id                 FK → cases.case_id           NOT NULL
report_request_id       FK → report_requests.request_id  NULLABLE
payment_type            ENUM('Initial Assessment','Report Request','Correction Fee','Other')
amount                  DECIMAL(10,2)
proof_of_payment        VARCHAR(500)  (cloud storage path or URL)
verification_status     ENUM('Pending','Approved','Rejected') DEFAULT 'Pending'
verified_by_staff_id    FK → staff.staff_id  NULLABLE
verified_at             NULLABLE
rejection_reason        TEXT NULLABLE
created_at              DEFAULT CURRENT_TIMESTAMP
```

Note: `report_request_id` links a payment to a specific report request when `payment_type = 'Report Request'`. For `Initial Assessment`, this field is NULL. Derive report request payment status directly from this table — do not store a redundant `payment_status` on `report_requests`.

---

### `appointments`

```
appointment_id    PK
case_id           FK → cases.case_id   NOT NULL
psychologist_id   FK → staff.staff_id  NOT NULL
appointment_type  ENUM('Online','Face-to-Face')
scheduled_start   DATETIME NOT NULL
scheduled_end     DATETIME NOT NULL
meeting_link      VARCHAR(500) NULLABLE  (required if type = 'Online')
status            ENUM('Pending','Confirmed','Completed','Cancelled','No Show') DEFAULT 'Pending'
notes             TEXT NULLABLE
created_at        DEFAULT CURRENT_TIMESTAMP
updated_at
```

Validation: `scheduled_start` must fall within the psychologist's `psychologist_availability` window for that day.

---

### `assessments`

```
assessment_id     PK
case_id           FK → cases.case_id   NOT NULL
psychologist_id   FK → staff.staff_id  NOT NULL
started_at        DATETIME NULLABLE
completed_at      DATETIME NULLABLE
remarks           TEXT NULLABLE
```

The assigned psychologist manually marks the assessment as complete. `completed_at` is set by the system at the moment of the action, not entered manually.

---

### `reports`

```
report_id               PK
case_id                 FK → cases.case_id   NOT NULL
prepared_by_staff_id    FK → staff.staff_id  NOT NULL
report_title            VARCHAR(255) NOT NULL
file_path               VARCHAR(500) NOT NULL  (cloud storage path or URL)
version                 INT DEFAULT 1
status                  ENUM('Draft','Awaiting Approval','Approved','Released','Archived')
revision_notes          TEXT NULLABLE
director_reviewed_by    FK → staff.staff_id  NULLABLE
director_reviewed_at    DATETIME NULLABLE
released_at             DATETIME NULLABLE
created_at              DEFAULT CURRENT_TIMESTAMP
updated_at
```

Note: When a report is revised, the current report record is updated with a new `file_path` and incremented `version`. Previous versions are preserved via the `audit_log`. Only one report per case should hold status `Approved` or `Released` at a time — the rest are `Archived`.

---

### `report_requests`

```
request_id       PK
report_id        FK → reports.report_id   NOT NULL
case_id          FK → cases.case_id       NOT NULL
user_id          FK → users.user_id       NOT NULL
request_type     ENUM('Request Copy','Correction','Clarification','Other Concern')
reason           TEXT NOT NULL
status           ENUM('Pending Review','Approved','Rejected','Completed') DEFAULT 'Pending Review'
approved_by      FK → staff.staff_id  NULLABLE
fulfilled_by     FK → staff.staff_id  NULLABLE
created_at       DEFAULT CURRENT_TIMESTAMP
updated_at
```

Payment status is derived by querying:
```sql
SELECT verification_status
FROM payments
WHERE report_request_id = :request_id
AND payment_type = 'Report Request'
ORDER BY created_at DESC
LIMIT 1;
```

---

### `audit_log`  *(New)*

Records every state change across all tables. Never deleted.

```
audit_id              PK
table_name            VARCHAR(100) NOT NULL
record_id             VARCHAR(100) NOT NULL
action                ENUM('INSERT','UPDATE','DELETE')
changed_by_staff_id   FK → staff.staff_id  NULLABLE
changed_by_user_id    FK → users.user_id   NULLABLE
old_value             JSON NULLABLE
new_value             JSON NULLABLE
changed_at            DEFAULT CURRENT_TIMESTAMP
ip_address            VARCHAR(45) NULLABLE
```

This table is append-only. No UPDATE or DELETE operations are permitted on it.

---

## Case Status Lifecycle

```
Pending Intake Review
    │
    ├─[Rejected]──────────────────► Intake Rejected  (terminal; client must submit new intake)
    │
    └─[Approved]
         │
         ▼
    Awaiting Initial Payment
         │
         ├─[Payment Rejected]──────► Awaiting Initial Payment  (stays; client re-uploads proof)
         │
         └─[Payment Approved]
              │
              ▼
         Awaiting Appointment
              │
              └─[Appointment Created]
                   │
                   ▼
              Scheduled
                   │
                   └─[Assessment Begins]
                        │
                        ▼
                   Assessment In Progress
                        │
                        └─[Marked Complete]
                             │
                             ▼
                        Assessment Completed
                             │
                             └─[Report Drafted]
                                  │
                                  ▼
                             Report Drafting
                                  │
                                  └─[Submitted for Review]
                                       │
                                       ▼
                                  Awaiting Director Approval
                                       │
                                       ├─[Rejected]─────► Report Drafting (revision loop)
                                       │
                                       └─[Approved]
                                            │
                                            ▼
                                       Report Approved
                                            │
                                            └─[Client Submits Request]
                                                 │
                                                 ▼
                                            Awaiting Report Request Approval
                                                 │
                                                 ├─[Request Rejected]─► Report Approved
                                                 │
                                                 └─[Request Approved]
                                                      │
                                                      ▼
                                                 Awaiting Report Request Payment
                                                      │
                                                      ├─[Payment Rejected]─► Awaiting Report Request Payment
                                                      │
                                                      └─[Payment Verified]
                                                           │
                                                           ▼
                                                      Ready for Release
                                                           │
                                                           └─[Psychologist Releases]
                                                                │
                                                                ▼
                                                           Released
                                                                │
                                                                └─[Manually Closed]
                                                                     │
                                                                     ▼
                                                                Closed
```

`Closed` is a terminal state. Cases are never deleted. If a client requires further assessment after closure, a new intake is submitted, creating a new Case.

---

## Workflow Specification

### Phase 1 — Intake Submission

**Actor:** Client

**Steps:**

1. Client logs in and completes the intake form.
2. Client selects a preferred psychologist from available staff (those with `role = 'Psychologist'` and `status = 'Active'`).
3. System validates that all required fields are present before proceeding.
4. System atomically creates:
   - A new `cases` record with `status = 'Pending Intake Review'` and `assigned_psychologist_id` set to the selected psychologist.
   - A new `intake_forms` record linked to the Case.
   - A new `audit_log` entry.
5. System generates and assigns the Case ID.
6. System creates a notification for the assigned psychologist.

**Notification sent to:** Assigned Psychologist

```
type:    CaseAssignment
title:   New Case Assigned
message: You have been assigned a new intake form.
         Case ID: CASE-XXXX
         Client: [full_name]
         Submitted: [submitted_at]
```

**Validation:**
- A client may not submit a new intake while they have an active case in any status other than `Intake Rejected`, `Released`, or `Closed`.

---

### Phase 2 — Intake Review

**Actor:** Assigned Psychologist (or Clinical Director / Administrator)

**Precondition:** `cases.status = 'Pending Intake Review'`

#### Option A — Approve Intake

1. Reviewer sets `intake_forms.review_status = 'Approved'`, `reviewed_by`, `reviewed_at`.
2. System sets `cases.status = 'Awaiting Initial Payment'`.
3. System sends notification to client.

**Notification sent to:** Client

```
type:    IntakeApproved
title:   Intake Approved
message: Your intake form has been approved.
         Please submit your initial payment to proceed.
         Case ID: CASE-XXXX
```

#### Option B — Reject Intake

1. Reviewer writes a rejection reason.
2. System creates a `case_notes` record:
   - `note_type = 'IntakeRejection'`
   - `is_visible_to_client = TRUE`
   - `content` = rejection reason
3. System sets `intake_forms.review_status = 'Rejected'`.
4. System sets `cases.status = 'Intake Rejected'`.
5. System sends notification to client.

**Notification sent to:** Client

```
type:    IntakeRejected
title:   Intake Requires Resubmission
message: Your intake form could not be approved.
         Please review the comments provided and submit a new intake.
         Case ID: CASE-XXXX
```

**Resubmission Rule:**
Rejected cases are terminal. The client must submit a new intake form, which creates a new Case. The new case record should note the prior rejection via `resubmission_count` (incremented from the most recent case for that user). The old case is preserved as a historical record.

---

### Phase 3 — Initial Payment Verification

**Actor:** Supervising Psychometrician or Clinical Director or Administrator

**Precondition:** `cases.status = 'Awaiting Initial Payment'`

1. Client uploads proof of payment. System creates a `payments` record with `payment_type = 'Initial Assessment'` and `verification_status = 'Pending'`.
2. Authorized staff reviews the proof.

#### Option A — Approve Payment

1. Staff sets `payments.verification_status = 'Approved'`, `verified_by_staff_id`, `verified_at`.
2. System sets `cases.status = 'Awaiting Appointment'`.
3. System creates a notification for the client.

**Notification sent to:** Client

```
type:    PaymentVerified
title:   Payment Confirmed
message: Your initial payment has been verified.
         Your case is now awaiting appointment scheduling.
         Case ID: CASE-XXXX
```

#### Option B — Reject Payment

1. Staff sets `payments.verification_status = 'Rejected'` with a `rejection_reason`.
2. Case status remains `Awaiting Initial Payment`.
3. Client is notified to re-upload proof.

**Notification sent to:** Client

```
type:    PaymentRejected
title:   Payment Could Not Be Verified
message: Your payment proof was not accepted.
         Reason: [rejection_reason]
         Please re-upload a valid proof of payment.
         Case ID: CASE-XXXX
```

---

### Phase 4 — Appointment Scheduling

**Actor:** Assigned Psychologist (or Clinical Director / Administrator)

**Precondition:** `cases.status = 'Awaiting Appointment'`

1. Psychologist selects a date, time, and appointment type.
2. System validates the selected time against `psychologist_availability` for the assigned psychologist.
3. System creates an `appointments` record with `status = 'Pending'`.
4. System sets `cases.status = 'Scheduled'`.
5. System confirms appointment: `appointments.status = 'Confirmed'`.
6. System sends notification to client.
7. The psychologist's dashboard must surface all confirmed upcoming appointments sorted by `scheduled_start`.

**Notification sent to:** Client

```
type:    AppointmentScheduled
title:   Your Appointment Has Been Scheduled
message: Your assessment appointment has been confirmed.
         Date: [scheduled_start]
         Type: [Online / Face-to-Face]
         [Meeting link if applicable]
         Case ID: CASE-XXXX
```

**Reminder Notification** (sent automatically 24 hours before `scheduled_start`):

```
type:    AppointmentReminder
title:   Appointment Reminder
message: You have an upcoming appointment tomorrow.
         Date: [scheduled_start]
         Case ID: CASE-XXXX
```

---

### Phase 5 — Assessment Conduct

**Actor:** Assigned Psychologist

**Precondition:** `cases.status = 'Scheduled'`

#### Starting the Assessment

1. Psychologist clicks **Start Assessment**.
2. System creates an `assessments` record with `started_at = CURRENT_TIMESTAMP`.
3. System sets `cases.status = 'Assessment In Progress'`.
4. System sets `appointments.status = 'Completed'`.

#### Completing the Assessment

1. Psychologist clicks **Mark Assessment Complete**.
2. System sets `assessments.completed_at = CURRENT_TIMESTAMP`.
3. System sets `cases.status = 'Assessment Completed'`.
4. System sends notification to Clinical Director.

**Notification sent to:** Clinical Director

```
type:    AssessmentCompleted
title:   Assessment Completed
message: The assessment for Case ID CASE-XXXX has been completed.
         Assigned Psychologist: [full_name]
         Completed at: [completed_at]
```

**No-Show Handling:**
If the psychologist marks the appointment as a no-show (`appointments.status = 'No Show'`), the case reverts to `Awaiting Appointment` and the client is notified to reschedule.

---

### Phase 6 — Report Drafting

**Actor:** Assigned Psychologist (or Psychometrician assisting)

**Precondition:** `cases.status = 'Assessment Completed'`

1. Psychologist uploads a report file (PDF or DOCX) to cloud storage.
2. System creates a `reports` record:
   - `status = 'Draft'`
   - `version = 1` (or incremented if re-drafted after rejection)
   - `file_path` = cloud storage path
3. System sets `cases.status = 'Report Drafting'`.
4. When the psychologist is ready, they click **Submit for Director Review**.
5. System sets `reports.status = 'Awaiting Approval'`.
6. System sets `cases.status = 'Awaiting Director Approval'`.
7. System sends notification to Clinical Director.

**Notification sent to:** Clinical Director

```
type:    ReportPendingApproval
title:   Report Awaiting Your Approval
message: A report has been submitted for review.
         Case ID: CASE-XXXX
         Prepared by: [full_name]
         Report: [report_title]
```

---

### Phase 7 — Director Approval

**Actor:** Clinical Director

**Precondition:** `cases.status = 'Awaiting Director Approval'`

#### Option A — Approve Report

1. Director sets `reports.status = 'Approved'`, `director_reviewed_by`, `director_reviewed_at`.
2. System sets `cases.status = 'Report Approved'`.
3. System sends notification to assigned psychologist.

**Notification sent to:** Assigned Psychologist

```
type:    ReportApproved
title:   Report Approved
message: The report for Case ID CASE-XXXX has been approved by the Clinical Director.
         The case is now ready for client report requests.
```

#### Option B — Return for Revision

1. Director writes revision notes.
2. System creates a `case_notes` record:
   - `note_type = 'ReportRevision'`
   - `is_visible_to_client = FALSE`
   - `content` = revision instructions
3. System sets `reports.status = 'Draft'` and increments `reports.revision_notes`.
4. System sets `cases.status = 'Report Drafting'`.
5. System sends notification to assigned psychologist.

**Notification sent to:** Assigned Psychologist

```
type:    ReportRevisionRequested
title:   Report Returned for Revision
message: The Clinical Director has requested revisions to the report for Case ID CASE-XXXX.
         Please review the revision notes and resubmit.
```

---

### Phase 8 — Report Request Submission

**Actor:** Client

**Precondition:** `cases.status = 'Report Approved'`

1. Client submits a report request form specifying:
   - `request_type`
   - `reason`
2. System creates a `report_requests` record with `status = 'Pending Review'`.
3. System sets `cases.status = 'Awaiting Report Request Approval'`.
4. System sends notification to assigned psychologist.

**Notification sent to:** Assigned Psychologist

```
type:    ReportRequestSubmitted
title:   Report Request Received
message: The client has submitted a report request for Case ID CASE-XXXX.
         Type: [request_type]
         Please review and approve or reject the request.
```

---

### Phase 9 — Report Request Review

**Actor:** Assigned Psychologist (or Clinical Director / Administrator)

**Precondition:** `cases.status = 'Awaiting Report Request Approval'`

#### Option A — Approve Request

1. Staff sets `report_requests.status = 'Approved'`, `approved_by`.
2. System sets `cases.status = 'Awaiting Report Request Payment'`.
3. System creates a `payments` record:
   - `payment_type = 'Report Request'`
   - `report_request_id` = the new request's ID
   - `verification_status = 'Pending'`
4. System sends notification to client.

**Notification sent to:** Client

```
type:    ReportRequestApproved
title:   Report Request Approved
message: Your report request for Case ID CASE-XXXX has been approved.
         Please proceed with the required payment.
```

#### Option B — Reject Request

1. Staff writes a rejection reason.
2. System creates a `case_notes` record with `note_type = 'ReportRequestNote'`, `is_visible_to_client = TRUE`.
3. System sets `report_requests.status = 'Rejected'`.
4. System sets `cases.status = 'Report Approved'` (returns to prior approved state).
5. System sends notification to client.

**Notification sent to:** Client

```
type:    ReportRequestRejected
title:   Report Request Rejected
message: Your report request for Case ID CASE-XXXX could not be approved.
         Reason: [rejection_reason]
```

---

### Phase 10 — Report Request Payment Verification

**Actor:** Supervising Psychometrician or Clinical Director or Administrator

**Precondition:** `cases.status = 'Awaiting Report Request Payment'`

1. Client uploads proof of payment to the existing `payments` record.

#### Option A — Payment Approved

1. Staff sets `payments.verification_status = 'Approved'`, `verified_by_staff_id`, `verified_at`.
2. System sets `cases.status = 'Ready for Release'`.
3. System sends notification to assigned psychologist.

**Notification sent to:** Assigned Psychologist

```
type:    RequestPaymentVerified
title:   Report Request Payment Confirmed
message: The report request payment for Case ID CASE-XXXX has been verified.
         Please proceed with releasing the report.
```

#### Option B — Payment Rejected

1. Staff sets `payments.verification_status = 'Rejected'` with `rejection_reason`.
2. Case status remains `Awaiting Report Request Payment`.
3. System sends notification to client.

**Notification sent to:** Client

```
type:    RequestPaymentRejected
title:   Report Request Payment Not Verified
message: Your payment proof for Case ID CASE-XXXX was not accepted.
         Reason: [rejection_reason]
         Please re-upload a valid proof of payment.
```

---

### Phase 11 — Report Release

**Actor:** Assigned Psychologist (or Clinical Director)

**Precondition:** `cases.status = 'Ready for Release'`

1. Psychologist clicks **Release Report** on the approved report.
2. System resolves report ownership entirely through relational traversal:

```
Report → Case → User
```

```sql
-- Determine the recipient automatically. No manual user selection.
SELECT c.user_id
FROM reports r
JOIN cases c ON r.case_id = c.case_id
WHERE r.report_id = :report_id;
```

3. System atomically updates:

```sql
UPDATE reports
SET status = 'Released', released_at = CURRENT_TIMESTAMP
WHERE report_id = :report_id;

UPDATE cases
SET status = 'Released', updated_at = CURRENT_TIMESTAMP
WHERE case_id = :case_id;

UPDATE report_requests
SET status = 'Completed', fulfilled_by = :staff_id, updated_at = CURRENT_TIMESTAMP
WHERE request_id = :request_id;
```

4. System sends notification to client.
5. The released report automatically appears in the client's Reports tab using:

```sql
SELECT r.*
FROM reports r
JOIN cases c ON r.case_id = c.case_id
WHERE c.user_id = :logged_in_user_id
  AND r.status = 'Released'
ORDER BY r.released_at DESC;
```

**No manual user assignment is ever performed during release.**

**Notification sent to:** Client

```
type:    ReportReleased
title:   Your Report Is Available
message: Your assessment report for Case ID CASE-XXXX is now available.
         You can view and download it from your Reports tab.
```

---

### Phase 12 — Case Closure

**Actor:** Clinical Director or Administrator

**Precondition:** `cases.status = 'Released'`

1. Staff clicks **Close Case**.
2. System sets `cases.status = 'Closed'`, `cases.closed_at = CURRENT_TIMESTAMP`.
3. System logs the action in `audit_log`.
4. Closed cases are read-only. No further transitions are permitted.

Automatic closure: Optionally, the system may automatically transition a case from `Released` to `Closed` after a configurable number of days (e.g., 90 days) with no activity.

---

## Notification Catalog

All `type` enum values for the `notifications.type` field:

| Enum Value                  | Recipient        | Trigger Event                                     |
|-----------------------------|------------------|---------------------------------------------------|
| `CaseAssignment`            | Psychologist     | New case created and assigned                     |
| `IntakeApproved`            | Client           | Intake form approved                              |
| `IntakeRejected`            | Client           | Intake form rejected                              |
| `PaymentVerified`           | Client           | Initial payment verified                          |
| `PaymentRejected`           | Client           | Initial payment rejected                          |
| `AppointmentScheduled`      | Client           | Appointment created and confirmed                 |
| `AppointmentReminder`       | Client           | 24 hours before scheduled appointment             |
| `AssessmentCompleted`       | Clinical Director| Assessment marked complete                        |
| `ReportPendingApproval`     | Clinical Director| Report submitted for director review              |
| `ReportApproved`            | Psychologist     | Report approved by director                       |
| `ReportRevisionRequested`   | Psychologist     | Report returned for revision                      |
| `ReportRequestSubmitted`    | Psychologist     | Client submitted a report request                 |
| `ReportRequestApproved`     | Client           | Report request approved                           |
| `ReportRequestRejected`     | Client           | Report request rejected                           |
| `RequestPaymentVerified`    | Psychologist     | Report request payment verified                   |
| `RequestPaymentRejected`    | Client           | Report request payment rejected                   |
| `ReportReleased`            | Client           | Report released by psychologist                   |

Unread notification count must be surfaced per user/staff session. The `action_url` field enables direct deep linking to the relevant case, report, or payment page.

---

## Validation Rules

The following rules must be enforced at the application layer before any database write is committed.

| Rule | Description |
|------|-------------|
| **Status prerequisite** | Every case status transition must validate that the current status matches the expected precondition. |
| **Role enforcement** | Every action must verify the actor's role and, where applicable, their assignment to the case. |
| **Intake uniqueness** | A client may not open a new intake while holding an active case (any status other than `Intake Rejected`, `Released`, or `Closed`). |
| **Payment before scheduling** | Appointment scheduling is blocked unless the case is in `Awaiting Appointment` status. |
| **Availability check** | Appointment scheduling must verify the psychologist has an `availability` window covering the selected time. |
| **Report submission gate** | A report may only be submitted for director approval if the case is in `Report Drafting` status and at least one report file has been uploaded. |
| **Release gate** | Report release is blocked unless `cases.status = 'Ready for Release'` and `reports.status = 'Approved'`. |
| **Single approved report** | When a new report version is approved, all previous reports for the same case must be set to `Archived`. |
| **Immutable audit log** | The `audit_log` table must have no UPDATE or DELETE permissions granted at the database level. |
| **Case ID immutability** | Once generated, a `case_id` may never be modified. |

---

## Data Integrity and Audit Requirements

- All status transitions must write an entry to `audit_log` capturing `old_value` and `new_value`.
- All file uploads (`proof_of_payment`, `file_path`) must be stored as references to cloud storage paths or URLs, not raw binary data in the database.
- Cases are never hard-deleted. `Closed` is the terminal state.
- Staff accounts use soft-delete only: set `staff.status = 'Inactive'`. Historical records referencing an inactive staff member are preserved.
- User accounts are never deleted. If deactivation is required, a separate `is_active` flag must be added to `users`.
- All timestamps are stored in UTC.
- `case_id`, `report_id`, `payment_id`, and `notification_id` values are never reused, even after closure.

---

## System Design Requirements

- **Extensibility:** All workflow transitions are driven by the `cases.status` field. Adding new statuses or phases must not require restructuring existing tables.
- **Scalability:** The `notifications` table is designed to support future migration to real-time delivery via WebSockets or Server-Sent Events without schema changes.
- **Maintainability:** No business logic is embedded in raw SQL. Status transitions, role checks, and notification dispatch are handled at the application layer.
- **Traceability:** Every state change across every table is captured in `audit_log`.
- **No data ambiguity:** All clinical records reference `case_id`, not `user_id`. `user_id` is used only for authentication and ownership resolution.
- **No manual ownership assignment:** Report ownership is always resolved relationally (`Report → Case → User`). Direct user assignment on report release is prohibited.
- **Case-centric:** Every module — payments, appointments, assessments, reports, notifications — is queryable by `case_id`.
