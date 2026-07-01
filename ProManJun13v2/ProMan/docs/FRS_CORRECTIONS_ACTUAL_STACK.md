# PsyGen FRS — Corrections to Match the Actual System

This reconciles the **Signed FRS** against what is actually implemented in the codebase.
Legend: ✅ = FRS is correct · ⚠️ = partly correct / needs wording fix · ❌ = wrong, replace it.

---

## System-wide corrections (apply everywhere in the FRS)

| FRS claims | Reality | Action |
|---|---|---|
| Supabase (Auth / Realtime / RLS / Edge Functions) | Not used anywhere | ❌ Remove all Supabase references |
| Frontend: React.js / Next.js / Angular | Vanilla **HTML5 + CSS3 + JavaScript (ES6)**, multi-page app, no build step | ❌ Replace with "Vanilla HTML/CSS/JS (MPA)" |
| CriminalIP.io (IP reputation / VPN detection) | Replaced by **MaxMind GeoLite2** (offline IP→location). No IP-reputation service. | ❌ Replace with MaxMind GeoLite2 |
| OpenSSL / **Libsodium** encryption libs | Libsodium not installed. No AES-256 at-rest in code (data stored plaintext). | ❌ Drop Libsodium; mark AES-256-at-rest as *Planned* |
| Email: SMTP / Nodemailer | **SendGrid** (`@sendgrid/mail`) | ❌ Replace with SendGrid |
| Real-time push (WebSocket / Socket.IO / Supabase Realtime) for notifications | DB-backed notifications + **20-second client polling** (+ focus refresh) | ⚠️ Reword "real-time" → "near-real-time (20s polling)" |

**Tools actually present but missing from the FRS:** Twilio (video), DocuSeal (e-signature), MaxMind GeoLite2 (geo), Google reCAPTCHA (CAPTCHA), AWS S3 (file/report storage).

---

## Module 1 — User Account & Access

- ✅ 6-digit OTP / 2-min expiry, SendGrid, password policy (8–12 + complexity), rate limit (5 / 3 min, 15-min lock), logout token revocation, bcrypt.
- ❌ Password Management "API used: **PHPGangsta/Google Authenticator**" — not used. Reset is a **single-use signed token (15 min) emailed via SendGrid**.
- ❌ "Suspicious login — API used: **CriminalIP.io**" → **MaxMind GeoLite2** (geo only; no VPN/proxy reputation).
- ❌ Session: "JWT signed with **RS256**" → actually **HS256** (symmetric `JWT_SECRET`), expiry **8h**.
- ⚠️ "Stored in HTTP-only Secure cookies" → the **JWT is sent as a Bearer token** in the `Authorization` header. There is an HttpOnly `bps_fp` **token-binding cookie** (SameSite=Strict) for anti-theft, but the JWT itself is not cookie-stored.
- ⚠️ "Session timeout 30 min inactivity" → JWT TTL is 8h; confirm/implement the inactivity timeout or correct the number.
- ✅ Device fingerprint logging via **FingerprintJS**.
- ➕ CAPTCHA is **Google reCAPTCHA** (gates login/register/etc.) — add it.

## Module 2 — Client Intake & Appointment

- ✅ SendGrid, validations (age > 17, RFC 5322, PH mobile), duplicate-email constraint, payment flow (GCash/QR, manual proof upload JPG/PNG/PDF, admin verify, reference numbers, transaction states).
- ❌ "AES-256 (at-rest)" on intake fields — **not implemented** (stored plaintext). Mark *Planned*.
- ❌ Encryption libraries "OpenSSL / Libsodium" — Libsodium not used.
- ⚠️ Audit trail logs mutations well; **read/view logging is partial**.
- ❌ Tools "CriminalIP.io" → MaxMind GeoLite2. ✅ FingerprintJS.

## Module 3 — Psychological Report Generation

- ✅ Node.js + Express, PostgreSQL, **Custom Rule Engine** (`ruleEngine.js` + externalized knowledge base), JWT + RBAC, audit fields.
- ⚠️ PDF: "PDFKit **or Puppeteer**" → **PDFKit** (with an HTML-template path); Puppeteer not used.
- ❌ "OpenSSL/Libsodium AES-256 report storage" → reports are **not encrypted at rest**; stored in PostgreSQL / **AWS S3**. Libsodium not used.
- ❌ "CriminalIP.io" → MaxMind GeoLite2.
- ➕ **DocuSeal** e-signature is used for the post-approval **Supervising → QC → Release** signing pipeline (signed-PDF persistence) — add it.
- ➕ Role logic: **psychometricians do not create reports**; report generation is done by **supervising psychometricians**, with psychologist review/approval and signature required before release.

## Module 4 — Community

- ❌ Frontend "React.js" → Vanilla JS.
- ❌ Search "Elasticsearch / Meilisearch / Algolia / Fuse.js" → **PostgreSQL LIKE / full-text**.
- ❌ FAQ editor "TinyMCE / CKEditor" → not used.
- ❌ Forums "Firebase Realtime DB / WebSocket / Socket.IO / Auth0 / Firebase Auth" → **PostgreSQL + custom JWT auth**; no realtime sockets.
- ❌ Voting "MongoDB or Redis" → **PostgreSQL** (`voteController`). ✅ express-rate-limit.
- ❌ Moderation "Perspective API (Google) + ELK Stack" → **custom `profanityFilter.js` + PostgreSQL audit logs**; vanilla dashboard (not React/Angular).
- ➕ Articles authored by staff, cleaned on fetch/import.

## Module 5 — Teleconference

- ❌ "VideoSDK" → **Twilio Programmable Video** (`twilio` SDK, `AccessToken`, rooms; realtime media over `wss://*.twilio.com`).
- ✅ Frontend Vanilla HTML5 + CSS, Node + Express, PostgreSQL, JWT, RBAC.
- ✅ Secure session access (Meeting ID + access token + role verification); ➕ adds an **email-OTP gate** and **invitation-token** redemption.
- ✅ Optional recording (Twilio), session logs.

## Module 6 — Message Dispatch (Notifications)

- ❌ Frontend "React.js" → Vanilla JS.
- ❌ Email "SMTP / Nodemailer" → **SendGrid**.
- ⚠️ "real time" → DB-stored notifications surfaced via **20-second polling** (+ focus refresh); SendGrid for email.
- ✅ Node + Express, PostgreSQL, JWT, RBAC.

## Module 7 — Client Profile

- ❌ Frontend "React.js / Next.js" → Vanilla JS.
- ❌ "PostgreSQL (**RLS** for privacy control)" → no row-level security; authorization is **app-layer (server-authoritative RBAC)**.
- ❌ Privacy controls "Postgres + RLS + **Edge Function** → JSON" and "delete… + **Auth account**" → plain **Express endpoints**; no Supabase Edge Functions / Supabase Auth.
- ❌ "AES-256 encryption for sensitive fields" → not implemented (*Planned*).
- ❌ FingerprintJS ✅ but "CriminalIP.io" → MaxMind GeoLite2.
- ❌ Generated Reports "stored encrypted (AES-256)" → not encrypted; ✅ JWT + RBAC + audit on view/download.

## Module 8 — Access & Operations

- ✅ Role hierarchy and per-role dashboards/notifications are accurate.
- ✅ APIs/Tools block is the already-corrected one (JWT + bcrypt + email-OTP/MFA · PostgreSQL notifications + 20s polling · SendGrid · PostgreSQL audit + FingerprintJS + MaxMind GeoLite2).
- ❌ "Backup & restore APIs" → not implemented yet (*Planned*).

## Module 9 — Data Protection & Backup

- ❌ "AES-256 at rest" → **not implemented** (plaintext). *Planned.*
- ⚠️ "TLS 1.3 + HSTS in transit" → HSTS/security headers via custom `securityHeaders.js`; TLS terminated at the proxy (deployment-level).
- ✅ bcrypt password hashing.
- ❌ "End-to-End Encryption (E2EE)" + "Key exchange **RSA-2048 / Curve25519**" → not implemented; only TLS-in-transit. *Planned / out of scope.*
- ❌ Backup Specifications (daily automated, encrypted, 30–90 day retention, manual trigger) → **not implemented** (*Planned*; no backup script/cron/route).
- ❌ RTO 2–4h / RPO 24h → **targets only**; no DR runbook/pipeline yet.
- ❌ Consent Management → not implemented (*Planned*).
- ❌ Data Anonymization → not implemented (*Planned*).
- Tools/Technologies:
  - ✅ PostgreSQL.
  - ⚠️ "AWS VPS" → AWS hosting **+ AWS S3** for file/report storage.
  - ✅ JWT (jsonwebtoken) + bcrypt + custom email-OTP/MFA.
  - ❌ "OpenSSL / Libsodium encryption libraries" → Libsodium not installed; no AES-256-at-rest; OpenSSL only appears in the *planned* backup script.

---

## Corrected master tech-stack (one-paragraph version)

**Backend:** Node.js + Express. **Database:** PostgreSQL (`pg`). **Frontend:** Vanilla HTML5 + CSS3 + JavaScript (multi-page app, no framework). **Auth:** custom JWT (HS256, `jsonwebtoken`) + bcryptjs + email-OTP/MFA, server-authoritative RBAC, HttpOnly token-binding cookie. **CAPTCHA:** Google reCAPTCHA. **Email:** SendGrid. **Notifications:** PostgreSQL-backed + 20s polling. **Video:** Twilio Programmable Video. **E-signature:** DocuSeal. **PDF:** PDFKit (+ HTML template path). **Report storage:** AWS S3. **Audit:** PostgreSQL log tables enriched with FingerprintJS (device) + MaxMind GeoLite2 (IP geolocation). **Rule engine:** custom Node.js service with externalized knowledge base.

**Planned / not yet implemented:** AES-256 encryption at rest, E2EE + key exchange, automated encrypted backups, disaster recovery (RTO/RPO), consent management, data anonymization.
