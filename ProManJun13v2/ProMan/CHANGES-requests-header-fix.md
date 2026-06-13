# Requests & Concerns — landing-style header + submission fix

## 1. Header now matches the Landing Page
`requests.html` (client) and `request-management.html` (clinic staff) now use the
*exact* navbar markup from `landingpage.html` — same brand, role-aware link list,
"Get Started" CTA (logged-out), notification bell, and profile icon, with the same
`navbar.css`. A small inline script adds the `logged-in` body class (mirroring the
landing page) so the profile icon shows and the CTA hides for signed-in users. The
shared `navbar.js` renders the correct client vs. staff menu automatically.

## 2. Submission error
The create-request endpoint is now resilient end-to-end:
- `activity_logs` is created by migrations (it previously lived only in a side SQL
  file), and every audit call is wrapped so a logging failure can never break a submit.
- Notification sends were already wrapped; verified by a smoke test that forces BOTH the
  audit log and the staff notification to fail — the request still returns HTTP 201 with
  a ticket number.
- `requests.html` now reports the real server message, flags database/"relation does not
  exist" errors with a "restart the backend" hint, and explains non-JSON/404 responses
  (which happen when the server hasn't been restarted to pick up the new routes).

**Action required:** restart the backend server so the new `/api/requests` routes and
the migrations (new tables + notification type) are loaded. After that, submitting the
form returns a ticket number and the entry appears under "My Tickets".
