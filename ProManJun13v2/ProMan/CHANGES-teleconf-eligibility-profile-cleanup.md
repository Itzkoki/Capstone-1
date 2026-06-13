# Teleconference Eligibility + Profile Cleanup

Two changes in this update:

1. **Teleconference eligibility** — only **verified** users can be assigned to a
   teleconference.
2. **Removed redundant profile information** — the *Health Background* and
   *Privacy and Data Controls* sections are removed from the profile page for
   all users.

---

## 1. Teleconference eligibility (verified users only)

A user's account must be **verified** (`users.is_verified = TRUE`) before they
can be assigned as the client of a teleconference session.

### Backend — `controllers/teleconferenceController.js`
- Added a `getEligibleClientOrError(clientId)` helper that loads the user and
  rejects the assignment if the account is not verified.
- **`createSession`** now checks eligibility right after validating `client_id`;
  an unverified client returns **400** with a clear message and no session,
  meeting, or participant records are created.
- **`assignClient`** (changing the client on an existing session) performs the
  same check before updating.

Verified result: `201/200 success`. Unverified result:
`400 — "<name> is not verified yet. Only verified users can be assigned to a teleconference."`

### Frontend — `meetings.html`
- The **Assign Client** dropdown now marks unverified clients with a
  "— Unverified" suffix and **disables** them (with a tooltip explaining they
  must verify first), so only verified clients can be picked. The server still
  enforces the rule as a safeguard against stale lists or direct API calls.

---

## 2. Removed redundant profile information

The *Health Background* (medical history, current medications, previous
treatments) and *Privacy and Data Controls* (visibility toggles) sections were
removed from the profile page for **every user**. This information is redundant
with the intake process.

### `profile.html`
- Removed the **Health Background** and **Privacy and Data Controls** sidebar
  nav links.
- Removed both `<section>` blocks (`#section-health-bg`, `#section-privacy`)
  including all their fields and forms.
- Removed the associated JavaScript: the `healthForm` / `privacyForm`
  references, the code that populated those fields on load, and the two
  save-handlers (`Save Health Info`, `Save Privacy Settings`).

The remaining profile sections (Profile Information, My Requests, Generated
Reports, Transaction History) and the section-switching navigation are
unchanged and continue to work.

> Note: only the profile-page UI was removed. The backend profile API and
> database columns are left intact so any clinical/intake features that rely on
> that data are unaffected.

---

## Verification performed
- Eligibility logic unit-tested: `createSession` and `assignClient` both return
  400 for an unverified client and succeed for a verified client.
- `meetings.html` rendered in a headless browser: verified client selectable,
  unverified client shown as "— Unverified" and disabled.
- `profile.html` rendered in a headless browser: Health Background / Privacy
  links and sections absent, page loads without errors, section navigation
  still works.
