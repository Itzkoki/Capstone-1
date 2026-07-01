# System Demo Recording Script — Barcarse Psychological Services (ProMan)

> End-to-end walkthrough: account creation → login → intake → counseling → payment → all roles.
> App runs at **http://localhost:5000**. Prepare a screen recorder + a real inbox (SendGrid emails 6-digit OTPs, valid **2 minutes**).

---

## 0. Pre-recording setup (do NOT record)

1. Start the backend:
   - Open a terminal in `.../ProMan/backend/`
   - Run `npm start` (or `npm run dev`). Wait for `🚀 Server running on http://localhost:5000`.
2. Have ready:
   - A fresh email you can open (for the **client** OTPs).
   - The **Clinical Director** login: username `Van` (+ its password + its email OTP inbox).
   - Optional: one account per staff role for the roles tour (see Part 7).
3. Open the site at `http://localhost:5000/landingpage.html`.
4. Clear a browser profile / use incognito so nothing is pre-logged-in.
5. Roles you'll show (lowest → highest privilege):
   `client → psychometrician → supervising_psychometrician → qc_psychometrician → psychologist → clinical_director`

---

## PART 1 — Create a client account (registration)

**Say:** "First, a new client registers for an account."

1. Landing page → click **Register** → `register.html`.
2. Fill in the registration form (name, email, password, etc.).
3. Submit. → App sends a **6-digit OTP** to the email; you're taken to email verification.
4. Open the inbox, copy the code, enter it (this flips the account to *verified*).
   - Show the **2-minute countdown** and the **Resend** button (first resend free, then 2-min cooldown).
5. Confirm the "verified / account created" success state.

**B-roll tip:** briefly show the OTP email arriving in the inbox.

---

## PART 2 — Log in as the client

**Say:** "Now the client logs in. Login requires an email OTP every time — two-factor by design."

1. Go to `login.html`.
2. Enter email + password → submit. → Instead of logging straight in, it **sends a fresh OTP** (`requiresVerification`).
3. Enter the OTP in the two-step form. Show the resend countdown.
4. On success you land on the client area (`profile.html`) — sidebar shows **My Requests / Generated Reports**.

---

## PART 3 — Intake forms

**Say:** "The client books a service by completing an intake form. There are two paths — Counseling and Assessment."

1. Start a booking → intake screen: **"What would you like to book?"**
   - **Counseling** — talk therapy / counseling sessions.
   - **Assessment** — psychological testing (uses the Assessment Intake form).

### 3a. Counseling intake (`intakeform.html`)
2. Click **Counseling**.
3. **Data Privacy & Ethics Consent** — show the PAP Code of Ethics / RA 10029 consent, then accept.
4. Fill the sections in order:
   - Personal Details
   - Presenting Concern
   - Therapy and Medication History
   - **Appointment Scheduling Preferences** (pick a date/time — note past time slots for today are disabled)
   - Minor Client Information (if applicable)
   - Emergency Contact Information
5. **Review and Submit** — show the review step, then submit.
6. Confirm the success/confirmation state.

### 3b. Assessment intake (`assessment-intake.html`) — optional to also show
7. Back to the choose screen → **Assessment** → consent → Client Information → Additional Information → **Assessment Schedule** → Review and Submit.

**Say:** "Submitting an intake creates a request that clinical staff will review and turn into a case."

---

## PART 4 — Counseling / teleconference session

**Say:** "Once scheduled, the counseling session happens over a secure teleconference."

1. Open `meetings.html` (Teleconference).
2. Show the **Email Verification gate** — accessing the session sends a teleconference OTP (same 2-min policy).
3. Enter the OTP → enter the **Consultation Session** room.
4. Show the video/consultation UI (session title, controls).

> Note: teleconference is used by BOTH clients and staff — good to mention on camera.

---

## PART 5 — Payment

**Say:** "For paid services, the client pays and staff verify the payment."

1. From the booking/appointment, go to `payment.html`.
2. Enter payment details / upload proof as the flow requires → submit.
3. Show the receipt (`receipt.html`).
4. **Switch to staff (payments-admin):** open `payments-admin.html` as a staff account.
   - Show the pending payment, then **verify** it.
   - Mention: appointment payments and request/ticket payments are verified through different paths, and both show up in the CD **Audit Trail → Payment Verification**.

---

## PART 6 — Reports (the signing pipeline)

**Say:** "After the case work is done, the psychological report goes through a multi-signature release pipeline."

1. As a **psychologist**, open `psych-reports.html` — write / edit the report.
2. Report moves through the post-approval pipeline:
   **Supervising Psychometrician sign → QC Psychometrician sign → Release.**
3. Show the signed PDF being generated/persisted.
4. As the **client**, go back to `profile.html → Generated Reports` to show the released report is now visible to them.

---

## PART 7 — All the roles (privilege tour)

**Say:** "Finally, here's what each role can do. Access is enforced by role-based access control on the server."

Log in via **`staff-login.html`** for staff (username + password + email OTP). Log in as the client via `login.html`.

| Role | Level | Log in via | Show these pages / powers |
|------|-------|-----------|---------------------------|
| **Client** | 0 | `login.html` | Book intake, pay, view own reports & requests (`profile.html`, `intakeform.html`, `payment.html`) |
| **Psychometrician** | 1 | `staff-login.html` | Base clinical staff — case work, assessments (`case-dashboard.html`) |
| **Supervising Psychometrician** | 2 | `staff-login.html` | Everything above **+ Supervising signature** on reports |
| **QC Psychometrician** | 3 | `staff-login.html` | **+ QC signature** step in the report pipeline |
| **Psychologist** | 4 | `staff-login.html` | Author/modify reports (`psych-reports.html`), handle concerns |
| **Clinical Director (Van)** | 5 | `staff-login.html` | Full control: approve & **release** reports, `staff-management.html`, `website-management.html`, `moderation.html`, `payments-admin.html`, and **Audit Trail / Audit Logs / Action Center** in `profile.html` |

**Demonstrate RBAC on camera:** while logged in as a lower role, try to open a CD-only page (e.g. `staff-management.html`) → show the **Access Denied** (`access-denied.html`) response. This proves the server enforces permissions, not just the UI.

### Clinical Director spotlight (strong closer)
- `staff-management.html` — create/manage staff & roles.
- `website-management.html` + `moderation.html` + `community.html` — manage public content/community.
- `profile.html` → **Audit Trail / Audit Logs / Action Center** — security events, IP geolocation, incident handling.

---

## Suggested recording order (single continuous take)

1. Register client (Part 1)
2. Verify email OTP (Part 1)
3. Client login + login OTP (Part 2)
4. Counseling intake + submit (Part 3a)
5. (Optional) Assessment intake (Part 3b)
6. Teleconference session + OTP (Part 4)
7. Payment + receipt (Part 5)
8. Staff verifies payment (Part 5)
9. Report authored → Supervising → QC → Release (Part 6)
10. Client sees released report (Part 6)
11. Roles tour + RBAC access-denied demo (Part 7)
12. Clinical Director admin spotlight (Part 7)

---

## Gotchas while recording
- **OTPs expire in 2 minutes** — don't pause too long between "send" and "enter code," or request a resend.
- Every client **login** needs a fresh OTP (not just registration).
- Staff log in on **`staff-login.html`**, clients on **`login.html`** — don't mix them up.
- For "today," past appointment time slots are disabled — pick a future slot.
- Keep the backend terminal visible in a corner if you want to show it's live (optional).
