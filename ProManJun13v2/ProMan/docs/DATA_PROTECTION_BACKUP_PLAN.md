# Data Protection & Backup Module — Implementation Plan

**System:** ProMan (Node.js/Express + PostgreSQL, deployed on AWS VPS)
**Goal:** Confidentiality, integrity, availability, and resilience for sensitive psychological/client data.
**Date:** 2026-06-14

---

## 0. Current State (what already exists)

| Capability | Status | Location |
|---|---|---|
| Password hashing (bcrypt) | ✅ Done | `controllers/authController.js` |
| JWT authentication | ✅ Done | `middleware/auth.js` |
| RBAC | ✅ Done | `middleware/rbac.js` |
| Activity / audit logging | ⚠️ Partial | `models/ActivityLog.js`, `models/AuditLog.js`, `middleware/activityLogger.js` |
| Rate limiting | ✅ Done | `middleware/rateLimiter.js` |
| Login attempt tracking | ✅ Done | `models/LoginAttempt.js` |
| Idempotent migrations | ✅ Done | `migrations.js` |
| AES-256 encryption at rest | ❌ Missing | reports/intake stored plaintext |
| HTTPS / TLS 1.3 / HSTS headers | ❌ Missing | no `helmet` in `server.js` |
| E2EE + key exchange | ❌ Missing | — |
| Device fingerprint in audit | ❌ Missing | `activity_logs` has IP only |
| Automated encrypted backups | ❌ Missing | — |
| Disaster recovery (RTO/RPO) | ❌ Missing | — |
| Consent management | ❌ Missing | — |
| Data anonymization | ❌ Missing | — |

The plan below fills the gaps without disrupting working features. Work is sequenced so each phase is independently shippable.

---

## Phase 1 — Transport Security & Hardening (Quick wins, ~1 day)

**Goal:** TLS 1.3, HSTS, secure headers.

1. **Add `helmet`** to `server.js` (after `cors`, before routes):
   ```js
   const helmet = require('helmet');
   app.use(helmet({
     hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
     contentSecurityPolicy: false, // enable later once CSP sources are mapped
   }));
   ```
   `npm i helmet`. HSTS prevents protocol-downgrade attacks.

2. **TLS 1.3 termination** at the AWS layer (recommended), not in Node:
   - Put the app behind **Nginx** (reverse proxy) or an **AWS ALB/ACM** cert.
   - Nginx: `ssl_protocols TLSv1.3 TLSv1.2;` (keep 1.2 as fallback), `ssl_prefer_server_ciphers off;`.
   - Force HTTP→HTTPS redirect at the proxy. `trust proxy 1` is already set in `server.js`.
   - Use a free **Let's Encrypt** cert via certbot (auto-renew).

3. **Tighten CORS** — replace `app.use(cors())` with an explicit origin allowlist from env (`CORS_ORIGIN`).

4. **Cookie/JWT review** — when moving JWT to cookies, set `Secure`, `HttpOnly`, `SameSite=Strict`. (Currently Bearer header — acceptable, document the choice.)

**Deliverables:** `helmet` middleware, Nginx TLS config in `docs/deploy/nginx.conf`, CORS allowlist.

---

## Phase 2 — Encryption at Rest (AES-256, ~2–3 days)

**Goal:** Encrypt sensitive columns so a DB dump leak does not expose client data.

**Approach:** Application-layer envelope encryption using Node's built-in `crypto` (AES-256-GCM). GCM gives confidentiality + integrity (auth tag). Keep PostgreSQL as-is.

1. **Key management:**
   - Master key (`DATA_ENCRYPTION_KEY`, 32 bytes base64) stored in env / AWS Secrets Manager — **never** in the repo.
   - Add to `.env.example` as a placeholder.
   - Plan for **key rotation**: store a `key_version` byte alongside each ciphertext.

2. **Create a crypto helper** `backend/utils/encryption.js`:
   ```js
   const crypto = require('crypto');
   // AES-256-GCM: returns base64( version(1) | iv(12) | tag(16) | ciphertext )
   function encrypt(plaintext) { /* randomBytes(12) IV, GCM, prepend tag */ }
   function decrypt(packed) { /* reverse, verify auth tag */ }
   ```
   (Optionally use **libsodium** `crypto_secretbox` via `sodium-native` — matches the "Libsodium" tooling spec. Pick one and standardize.)

3. **Target columns** (highest sensitivity first):
   - `psychological_reports`: `client_name`, `client_age`, `client_gender`, report body/sections.
   - Intake form submissions (`intake_*` tables): all PII + free-text answers.
   - Teleconference session metadata where it contains PII.
   - Change column type to `TEXT`/`BYTEA` to hold ciphertext; encrypt in the model layer (`models/PsychologicalReport.js`, intake model) on write, decrypt on read.

4. **Migration of existing rows:** write a one-off script `backend/scripts/encrypt-existing.js` that reads plaintext, encrypts, writes back — run once, gated by a flag.

5. **Searchability caveat:** encrypted columns can't be `LIKE`-searched. For fields needing search (e.g. client name lookup), add a **blind index** (HMAC-SHA256 of normalized value) in a separate column. Document which fields lose search.

**Deliverables:** `utils/encryption.js`, updated models, backfill script, key-rotation note.

---

## Phase 3 — Audit Trail Enhancement (~1–2 days)

**Goal:** Meet the spec'd audit fields: user ID, timestamp, IP, **device fingerprint**; log data access, record modification, report generation, login activity.

1. **Add `device_fingerprint` column** to `activity_logs` (migration in `migrations.js`).
2. **Capture fingerprint** in `middleware/activityLogger.js`: hash of `User-Agent` + `Accept-Language` + client-sent fingerprint header (`X-Device-Fingerprint`). Add a small frontend fingerprint (e.g. FingerprintJS or a hand-rolled hash).
3. **Log read access to sensitive resources** — current `activityLogger` only logs mutations (POST/PUT/DELETE). Add explicit audit calls on **GET of reports/intake** (data access is a spec requirement).
4. **Ensure report generation** (PDF export via `pdfkit`) writes an audit entry.
5. **Login activity** already in `LoginAttempt` — surface it in the admin audit view.
6. **Make audit logs tamper-evident** (integrity): append-only table, restrict UPDATE/DELETE via DB role; optionally hash-chain each row (`prev_hash`).

**Deliverables:** schema update, fingerprinting, read-access logging, admin audit view query.

---

## Phase 4 — Backup & Encrypted Storage (~2 days)

**Goal:** Daily automated, encrypted backups; 30–90 day retention; manual trigger.

1. **Automated daily full backup** — `pg_dump` via cron on the AWS VPS:
   ```bash
   pg_dump -Fc "$DATABASE_URL" | openssl enc -aes-256-cbc -pbkdf2 -pass env:BACKUP_KEY \
     > /backups/proman_$(date +%F).dump.enc
   ```
   Encrypt **before** storage (OpenSSL AES-256, matches tooling spec).
2. **Offsite copy** — sync `/backups` to **AWS S3** (`aws s3 cp`, bucket with SSE-KMS + versioning + restricted IAM).
3. **Retention** — lifecycle rule / cron prune: delete encrypted dumps older than 90 days; keep ≥30. (S3 lifecycle policy or a `find -mtime +90 -delete` job.)
4. **Manual backup endpoint** — admin-only route `POST /api/system/backup` (RBAC `clinical_director`) that triggers the same script; for use before major updates. Log it to the audit trail.
5. **Backup verification** — weekly automated **restore test** into a scratch DB; alert on failure. Untested backups are not backups.

**Deliverables:** `docs/deploy/backup.sh`, cron entries, S3 lifecycle policy, manual-backup route.

---

## Phase 5 — Disaster Recovery (~1 day, mostly runbook)

**Goal:** RTO 2–4h, RPO ≤24h.

1. **DR runbook** `docs/deploy/DISASTER_RECOVERY.md`: step-by-step restore (provision VPS → install deps → restore latest encrypted dump → restore env/secrets → smoke test).
2. **RPO ≤24h** is met by daily backups. To tighten, enable PostgreSQL **WAL archiving / PITR** later (optional).
3. **RTO 2–4h** — keep an infra-as-code / documented provisioning script so a fresh box is reproducible. Store secrets in AWS Secrets Manager (not only on the box).
4. **DR drill** — schedule a quarterly restore drill; record actual RTO achieved.

**Deliverables:** DR runbook, secrets-recovery checklist, drill schedule.

---

## Phase 6 — Compliance: Consent & Anonymization (~2 days)

**Goal:** Consent before data submission; anonymized analytics dataset.

1. **Consent management:**
   - `consents` table: `user_id`, `consent_type`, `version`, `granted_at`, `ip_address`, `revoked_at`.
   - Block intake/report submission until consent is recorded (middleware or controller check).
   - Versioned consent text so you can prove what was agreed to and when.
2. **Data anonymization:**
   - A view/export job that strips/pseudonymizes direct identifiers (name → hashed ID, exact age → age band, drop free-text) for analytics/research.
   - Keep anonymized data in a separate schema; never join back to identity without authorization.

**Deliverables:** `consents` table + check, anonymized export script.

---

## Cross-cutting: Secrets & Config

- Move all secrets (`JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `BACKUP_KEY`, DB password, SendGrid/Twilio keys) into **AWS Secrets Manager**; the box pulls them at boot.
- `JWT_SECRET` in `.env.example` is a weak placeholder — generate 256-bit random secrets per environment.
- Confirm `.env` is git-ignored (it is) and never committed.

---

## Suggested Sequencing

```
Week 1: Phase 1 (TLS/HSTS) ──► Phase 4 (Backups)  ← highest risk-reduction per effort
Week 2: Phase 2 (Encryption at rest) ──► Phase 3 (Audit)
Week 3: Phase 5 (DR runbook) ──► Phase 6 (Consent/Anonymization)
```

Phase 1 and Phase 4 give the biggest protection for the least effort — do them first. Phase 2 is the largest change (touches models + data migration) and should be tested on a copy of the DB before production.

---

## Out of Scope / Decisions Needed

- **E2EE (RSA-2048 / Curve25519):** True end-to-end (psychologist↔client) requires client-side key management and changes the app's trust model (server can't read content). Confirm whether "E2EE" means real client-side E2EE, or TLS-in-transit + AES-at-rest (which Phases 1–2 deliver). Most platforms of this type do the latter — recommend starting there.
- **Teleconference encryption:** depends on the SDK chosen (e.g. Twilio Video / Daily / Jitsi); rely on the SDK's media encryption (DTLS-SRTP) rather than building it.
- **Supabase:** the spec lists Supabase for auth, but the current code uses self-hosted PG + custom JWT auth. Decide whether to migrate auth to Supabase or keep the existing stack (keeping it is lower-risk).
```
