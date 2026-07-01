# S3 Report Delivery — Implementation Plan

**System:** ProMan (Node.js/Express + PostgreSQL on AWS VPS)
**Goal:** Make the **Download** buttons (client's Generated Reports) and **"Use Stored Report"**
(Clinical Director's Send-to-Client page) functional by delivering the finished report PDF
from **AWS S3**, while keeping the PDF in the database so the daily DB backup still covers it.
**Date:** 2026-06-30

---

## Core pattern

> **Database = source of truth (backed up). S3 = regenerable serving copy.**

- The report PDF stays in Postgres (covered by the daily DB backup).
- A copy also lives in S3, used only to *deliver* the file fast.
- Because the DB is the master, the S3 copy is **disposable** — if S3 ever loses a file,
  it's re-uploaded from the DB. → **No separate app-files backup bucket is required.**

## Delivery model — hybrid presigned URLs

The download endpoint stays the gatekeeper:
1. Checks the user's role (RBAC).
2. **Logs the access** (spec requires report-access auditing).
3. Redirects the browser to a **short-lived (~60s) presigned URL**; S3 serves the bytes.

A **fresh presigned URL is minted on every click**, so the expiry only covers the moment
between generation and download — a client can never "miss their window." A leaked link
dies in ~60s. The bucket stays private (Block Public Access on) the entire time.

---

## AWS setup (DONE)

| Item | Value / Status |
|---|---|
| Bucket | `barcarse-proman-files` (region `ap-southeast-1`) |
| Block Public Access | ON (all four) |
| Versioning | Enabled (free recovery of deleted/overwritten files) |
| Default encryption | SSE-S3 |
| Object Ownership | ACLs disabled (bucket-owner enforced) |
| IAM user | `proman-s3-server` (programmatic only, console disabled) |
| IAM policy | `proman-s3-access` — inline, scoped to the one bucket (Put/Get/Delete/List) |
| `.env` | `AWS_REGION=ap-southeast-1`, `S3_BUCKET=barcarse-proman-files`, key + secret |

> ⚠️ The first access key was exposed in screenshots and should be rotated
> (IAM → `proman-s3-server` → Security credentials → delete old key → create new).

## Code scaffolding (DONE)

- `backend/services/s3Storage.js` — `putObject`, `getObjectBuffer`, `getPresignedUrl`,
  `deleteObject`, `objectExists`, `isConfigured`. Falls back gracefully if S3 isn't configured.
- `backend/scripts/s3-test.js` — one-shot PUT → presigned GET → DELETE connectivity test.
- `backend/package.json` — added `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.

---

## Remaining work

1. **Prove connectivity** — ✅ DONE. `node scripts/s3-test.js` prints `🎉 All good`
   (PUT → presigned GET → DELETE all pass).

2. **DB migration** — ✅ DONE (`backend/migrations.js`). Added `s3_key VARCHAR(512)` to
   `client_request_report_versions` and `report_signed_pdfs`. Idempotent
   `ADD COLUMN IF NOT EXISTS`; runs automatically on next server start.

3. **On report save (dual-write)** — ✅ DONE. `requestController.sendReport` keeps writing the
   base64 into the DB **and** uploads the PDF to S3 at `reports/request-{id}/v{n}-{ts}.pdf`
   via `uploadVersionToS3()`, storing the `s3_key`. Best-effort: a failed upload leaves
   `s3_key` NULL and downloads fall back to base64.

4. **`getRequestFile`** — ✅ DONE. `type=report`/`version`: `servingUrlOrBase64()` returns a
   120s presigned URL when `s3_key` is set, else the base64. Report downloads are audited
   (`REPORT_DOWNLOADED`, records S3 vs DB path).

5. **Buttons** — ✅ No UI rewrite needed. "Use Stored Report" enables once a version row
   exists; `downloadRequestReport` / `downloadGeneratedReport` keep calling the same endpoint
   and now receive S3 presigned links transparently.

6. **Scope** — new reports only; **no backfill** of existing base64 rows.

## Deferred (column ready, not wired)

- **Released psychological report** (`GET /api/reports/:id/pdf`, `downloadReleasedReport`):
  this endpoint **streams** the PDF (not a JSON `dataUrl`) and the client reads `res.blob()`.
  Serving from S3 needs either a cross-origin redirect (requires an **S3 CORS config**) or a
  server-side S3 fetch. Left streaming from the DB for now; `report_signed_pdfs.s3_key` is
  ready for when this path is moved.

---

## Affected files

| File | Change | Status |
|---|---|---|
| `backend/services/s3Storage.js` | NEW — S3 wrapper | ✅ |
| `backend/scripts/s3-test.js` | NEW — connectivity test | ✅ |
| `backend/package.json` | AWS SDK deps | ✅ |
| `backend/migrations.js` | `s3_key` columns | ✅ |
| `backend/controllers/requestController.js` | upload on save; presigned URL in `getRequestFile` | ✅ |
| released-report serving path | move to S3 | ⏸ deferred |

## Open item

- **VPS deployment method** — `git pull` vs direct edit (nano / VS Code Remote) — determines
  how the two new files reach the server to run the test.
