# PsyGen — Row-Level Security & Field Encryption Plan

Design + migration plan to implement the two security items the FRS marks as *Planned*:

- **Module 7:** PostgreSQL **Row-Level Security (RLS)** for privacy control (today: app-layer RBAC only).
- **Modules 2 / 7 / 9:** **AES-256 encryption at rest** for sensitive fields (today: plaintext).

This closes the two biggest gaps between the signed FRS and the real system. See
`FRS_CORRECTIONS_ACTUAL_STACK.md` for the source-of-truth stack.

---

## 0. Does this affect existing data?

| | Touches existing rows? | Reversible? |
|---|---|---|
| **RLS** | **No.** Never changes stored data — it's a read/write *filter* deciding which rows a query sees. Existing rows stay byte-for-byte identical. | Yes, instantly: `ALTER TABLE … DISABLE ROW LEVEL SECURITY`. |
| **Encryption at rest** | **Yes.** Plaintext columns are re-written into ciphertext by a one-time **backfill migration** — this transforms *all* previous data. | Only while you still hold the key **and** a backup. Losing the key = permanent data loss. |

- RLS applies automatically the moment it's enabled — no migration of existing rows.
- Encryption applies to existing data via a **backfill script** that walks every row.
- RLS failure mode is "queries return nothing" (empty lists), never data loss. Encryption is a real data migration: **take a full backup first**.

---

## 1. Actual stack (the constraints that shape this)

- **PostgreSQL** via `pg`, one pooled DB role (`config/db.js → pool.query(text, params)`).
- **534** `db.query` call sites across controllers/models, all through that single helper.
- **App-layer RBAC** today (`middleware/rbac.js`); no RLS.
- `req.user = { id, email, role, type }` (`type` = `staff` | client) from JWT (`middleware/auth.js`).
- 10 controllers already use explicit transactions (`caseController`, `paymentController`,
  `profileController`, `reportController`, `requestController`, `requestShared`,
  `staffAuthController`, `staffController`, `teleconferenceController`, `landingController`).
- Sensitive data lives mostly in: `intake_forms.form_data` (JSONB PII blob), `user_profiles`,
  `users.contact_number`, `client_requests`, report/assessment content, `meetings`.

---

## 2. Row-Level Security

### 2.1 The deciding fact
Postgres RLS keys off **the DB role (`current_user`) or a session variable**. The app uses **one
pooled role** and never tells the DB *who* `req.user` is. So identity must be injected into the DB
session per request.

**Two gotchas:**
1. **Table owners and superusers bypass RLS silently.** The app must run as a dedicated
   least-privilege role (`proman_app`) that does **not** own the tables, and each table needs
   `FORCE ROW LEVEL SECURITY`.
2. **Pooled connections leak session state.** Identity must be set with **transaction-local scope**
   (`set_config('app.user_id', …, true)`) or one request's identity bleeds into the next request
   that reuses the connection.

### 2.2 Design
1. **AsyncLocalStorage middleware** (after `authenticate`): stash `{ id, type, role }` in a
   request-scoped store. Avoids editing all 534 call sites.
2. **RLS-aware `db.query`**: check out a client, run
   `set_config('app.user_id', $1, true)` + `app.user_role` + `app.user_type` inside a transaction,
   run the real query, commit, release. Provide `withTransaction(fn)` for the 10 controllers that
   already manage their own transactions (set context once at `BEGIN`).
3. **Per-table policies** using `current_setting('app.user_id')`:
   - Client-owned (`intake_forms`, `user_profiles`, `privacy_settings`, `client_requests`,
     `notifications`, `meetings`): client sees only `user_id = current_setting('app.user_id')::int`;
     staff by role.
   - Staff/clinical (reports, assessments, cases): policies by `app.user_role`
     (CD / psychologist / psychometrician / SPM).
   - Public (`articles`, `faqs`, `forum_threads`): permissive read.
   - Keep a `BYPASSRLS` role for backups, migrations, and rule-engine batch jobs.
4. **Keep app-layer RBAC** — RLS is defense-in-depth *underneath* `rbac.js`, not a replacement.

### 2.3 Example (illustrative)
```sql
-- dedicated app role (NOT owner, NOT superuser)
CREATE ROLE proman_app LOGIN PASSWORD '…';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO proman_app;

ALTER TABLE intake_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_forms FORCE ROW LEVEL SECURITY;

CREATE POLICY intake_client_own ON intake_forms
  USING (user_id = current_setting('app.user_id', true)::int)
  WITH CHECK (user_id = current_setting('app.user_id', true)::int);

CREATE POLICY intake_staff_read ON intake_forms
  FOR SELECT
  USING (current_setting('app.user_type', true) = 'staff');
```

### 2.4 Rollout (reversible, table-by-table)
1. Create `proman_app`; grant privileges; point staging `DB_USER` at it.
2. Enable RLS on **`notifications`** first (low risk) with a permissive policy; smoke-test.
3. Roll table-by-table, most sensitive last; run existing tests + manual module smoke after each.
4. `FORCE ROW LEVEL SECURITY` per table once policies verify.

---

## 3. Field Encryption — App-layer AES-256-GCM

### 3.1 Threat model (state this in the FRS)
Protects against **stolen DB dumps, disk/backup theft, DBA snooping**. Does **not** protect against
an app-server compromise (the running app holds the key and decrypts on demand).

### 3.2 Chosen approach: Node `crypto`, AES-256-GCM
Selected over `pgcrypto` because the key never touches the database or SQL logs, it matches the FRS
"AES-256" wording, and GCM's auth tag gives tamper detection.

- New `utils/fieldCrypto.js`: `encrypt(plaintext) → {iv, tag, ciphertext, keyId}` packed into one
  `bytea`/`text` column; `decrypt()` reverses it.
- Master key from `process.env.FIELD_ENC_KEY` (32 bytes), ideally wrapped by **AWS KMS** (already on AWS).
- Store a `keyId` alongside ciphertext to allow key rotation later.

### 3.3 Target columns
- `intake_forms.form_data` (whole PII intake payload — **top priority**)
- `user_profiles` PII fields + `users.contact_number`
- `client_requests` free-text bodies
- report/assessment content (`client_request_report_versions`, assessment data)
- Leave ids, timestamps, status enums as plaintext.

### 3.4 Searchability tradeoff (plan per column BEFORE encrypting)
Encrypted columns **cannot** be `LIKE`/indexed/sorted. For any field you look up by (e.g. **email at
login**), add a **blind index**: a sibling `*_hmac` column = `HMAC-SHA256(key, normalized_value)`,
indexed, for exact-match lookups.

### 3.5 Applying encryption to existing data — two paths

Pick based on whether current DB data is real or disposable (**TBD — user to confirm**).

**Path A — Wipe & start fresh (only if data is test/demo/seed).** Simplest; removes the whole
backfill step.
1. Back up the current DB anyway (cheap insurance).
2. Recreate the schema with encrypted columns + `*_hmac` blind-index columns defined from the start.
3. Ship `fieldCrypto.js` and the encrypted read/write paths.
4. **Re-seed *through the app's encrypt logic*, not raw SQL** — raw inserts would put plaintext into
   columns the app expects to be ciphertext.

   *Saves:* no backfill script, no sibling-column/drop dance, no migration downtime.
   *Does NOT save:* still need `fieldCrypto.js`, blind indexes designed up front, RLS, and re-seed.

**Path B — Backfill existing rows (if data must be kept).**
1. **Full backup first** (non-negotiable).
2. Add nullable sibling column per target (`form_data_enc bytea`).
3. `scripts/encrypt-backfill.js`: batch every existing row, read plaintext → write ciphertext, in
   transactions with a resumable cursor.
4. Feature-flag the app to read/write the encrypted column.
5. Verify a decrypt sample matches the original; then drop plaintext columns in a later migration.
6. Support key rotation via the stored `keyId`.

*Mix of both:* export the few real rows, wipe (Path A), then re-import them through the encrypt path.

**Reversibility:** full while you hold the key + backup. After dropping plaintext columns, key +
backup are the only path back — guard them.

---

## 3.6 Chosen path: wipe both local + prod (data is test-only)

Production DB holds test data only — nothing to keep. So **Path A** applies to both environments;
the backfill (Path B) is dropped entirely.

**After wiping, re-seed ONLY these 5 staff login accounts** (everything else starts empty). Create
them **through the app's staff-creation path, not raw SQL** — so passwords are bcrypt-hashed and any
encrypted staff fields are written as ciphertext via `fieldCrypto`.

| Name | Title | Role code |
|---|---|---|
| Van | Clinical Director | `clinical_director` |
| Robi | Psychologist | `psychologist` |
| James | Quality Control | `quality_control` |
| Kiana | Supervising Psychometrician | `supervising_psychometrician` |
| Wes | Psychometrician | `psychometrician` |

**Deploy sequence (prod):** set `FIELD_ENC_KEY` + HMAC key env vars on the server → drop/replace prod
DB with new schema (encrypted + `*_hmac` columns + RLS policies) → push new code → point `DB_USER` at
`proman_app` → seed the 5 staff via the app → smoke-test one login + one encrypted read/write.

## 4. Phasing

- **Phase 0 — Backup + staging clone.** Validate everything on a clone first.
- **Phase 1 — RLS** (no data mutation, reversible): least-privilege role → `db.js` context injection
  → table-by-table policies. Ship first; safe win, closes FRS Module 7 gap.
- **Phase 2 — Encryption** (mutates data): `fieldCrypto.js` → blind indexes for searched columns →
  backfill `intake_forms.form_data` first → expand → drop plaintext columns.
- **Phase 3 — FRS update:** move RLS + AES-256-at-rest from *Planned* → *Implemented*; document key
  management + threat model.

## 5. Top risks
1. App DB role accidentally **owning** tables → RLS silently bypassed.
2. **Pooled-connection identity leakage** if context isn't transaction-local.
3. **Losing the encryption key.**
4. Forgetting a **blind index** → breaks a login/search lookup.
