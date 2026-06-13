# Requests & Concerns — submission 500 fix + navbar icon consistency

Two issues in the Request & Concern feature, both fixed.

## 1. Internal Server Error on form submission

**Symptom.** Submitting the Request & Concern form returned a 500. The
`client_requests` table did not exist, so the `INSERT` in
`requestController.createRequest` failed with `relation "client_requests" does
not exist`.

**Root cause (not a missing schema).** The table *was* already defined in
`backend/migrations.js` (step #30), with every required field. The problem was
structural: the whole body of `runMigrations()` runs inside a single
`try/catch` that logs any error as "non-fatal" and stops. Because the requests
tables were created near the very end, **any earlier migration step that threw
silently skipped them** — leaving the table absent and the form returning 500.
Reproduced against a real PostgreSQL instance: when an earlier step failed
(e.g. `relation "notifications" does not exist`), the requests tables were
never created.

**Fix (`backend/migrations.js`).**
- Extracted the table creation into a self-contained, idempotent helper
  `ensureRequestTables()` (`CREATE TABLE IF NOT EXISTS` + indexes) that swallows
  its own errors.
- It is called **first**, at the top of `runMigrations()`, so the Request &
  Concern tables (`client_requests`, `client_request_replies`) are created
  reliably on every startup regardless of whether any other migration step
  succeeds or fails. The original step #30 now just calls the same helper
  (harmless, idempotent).
- After the fix, the same forced-failure scenario still creates both tables, and
  a simulated submission succeeds (ticket `BPS-REQ-YYYYMMDD-001`, status
  `submitted`, timestamps populated, replies + list queries all working).

The table covers every requested field: ticket/reference number, client name
(family / given / M.I.), parent-guardian name, date of assessment, contact
number, center & branch, nature of request, concerns encountered (+ "other"),
brief description, attached file (data / name / mime), ticket status, assigned
staff, resolution notes, and created/updated timestamps. (Plus the existing
payment_* and report_* columns for the additional-copies fee and report-release
flow.)

**`backend/client_requests_schema.sql` (new).** A standalone, idempotent script
to create the tables immediately in an already-running database **without
restarting the server**:

    psql -h localhost -U postgres -d proman_db -f client_requests_schema.sql

**Action required:** restart the backend so the up-front migration runs — or run
the SQL above against the live DB to create the table right now.

## 2. Navbar notification & profile icons inconsistent

**Symptom.** On `requests.html` and `request-management.html` the bell and
profile icons looked different from the rest of the system: the profile was a
filled blue circle and the bell was a bare, dark, barely-visible glyph.

**Root cause.** Nearly every page loads both `navbar.css` *and*
`design-system.css`; `design-system.css` is what renders the icons as matching
42px translucent rounded-square chips with 19px white glyphs and a gold hover.
`navbar.css` itself does **not** style these icons. `requests.html` and
`request-management.html` were the only navbar pages that loaded `common.css`
but **not** `design-system.css`, so their icons fell back to the `common.css`
look (blue circle profile + bare bell).

**Fix.** Added a small, scoped block to each page's existing inline `<style>`
that mirrors `design-system.css`'s icon rules exactly (42x42, border-radius 10px,
border 1px solid rgba(255,255,255,.25), background rgba(255,255,255,.12),
transition all .18s ease; hover border-color #C0922E + background
rgba(255,255,255,.2); SVG fill #fff at 19x19). The --ds-radius-sm (10px) and
--gold (#C0922E) tokens are inlined since design-system.css is not loaded on
these pages. Kept scoped (rather than linking the whole design-system.css) to
avoid restyling the pages' bespoke ticket UI — e.g. request-management.html has a
standalone class="tag" element that design-system.css's generic .tag rule would
otherwise affect.

Result: both icons now match the landing-page navbar exactly in size, color,
spacing, and hover behaviour. The markup was already identical; only the missing
styling was supplied.

## Files changed
- `backend/migrations.js` — `ensureRequestTables()` runs up front.
- `backend/client_requests_schema.sql` — **new**, standalone table creation.
- `requests.html` — scoped navbar icon styling.
- `request-management.html` — scoped navbar icon styling.
