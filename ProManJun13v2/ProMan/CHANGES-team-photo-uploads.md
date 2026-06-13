# Team Photos — File Upload Architecture (no Base64)

Team photos are no longer stored as Base64 strings in the database. The 24
BPS-STAFF images now live as **real files on the server's upload directory**, and
the database stores only the **file path**. All previous functionality (the
click-to-expand carousel modal and full editability via Website Management) is
retained.

```
BEFORE:  BPS-STAFF zip → Base64 JSON seed → data-URLs in DB
AFTER:   BPS-STAFF zip → image files on disk → DB stores the path → served from /uploads
```

---

## On-disk layout

```
backend/uploads/team/
  thumbs/   alfred-anthony.jpg, ann-toni.jpg, …   (carousel thumbnails)
  full/     alfred-anthony.jpg, ann-toni.jpg, …   (expanded pop-up images)
```

The database columns hold only the location, e.g.

| Column            | Value                                      |
|-------------------|--------------------------------------------|
| `photo_thumbnail` | `/uploads/team/thumbs/alfred-anthony.jpg`  |
| `photo_full`      | `/uploads/team/full/alfred-anthony.jpg`    |

The actual files are served by Express from `/uploads`.

---

## What changed

### Backend
- **`server.js`** — added `app.use('/uploads', express.static(backend/uploads))`
  so uploaded files are served at `/uploads/...`.
- **`migrations.js`**
  - The thumbnail column is now **`photo_thumbnail`** (was `photo`). Older
    databases are upgraded automatically with a guarded
    `ALTER TABLE … RENAME COLUMN photo TO photo_thumbnail`.
  - The team seed inserts **file paths** from `backend/seed/team-seed.json`
    (which now contains paths only — no Base64).
  - Idempotent upgrade: any leftover Base64 / NULL photo values from an earlier
    build are converted to the on-disk file paths (matched by member name).
- **`models/TeamMember.js`** — uses `photo_thumbnail` in all queries.
- **`controllers/landingController.js`**
  - Photo fields are validated as **paths** (`/uploads/team/...`) or http(s)
    URLs; Base64 `data:` values are rejected — the image must be uploaded first.
  - New `uploadTeamPhoto` handler returns the stored path.
- **`routes/landing.js`** — new endpoint
  `POST /api/landing/team/upload?kind=thumb|full` (Clinical Director only).
  Uses **multer** to write the file to `backend/uploads/team/{thumbs,full}/`
  (image-only, 8 MB limit) and returns `{ data: { path } }`.
- **`backend/seed/team-seed.json`** — regenerated as **path-only** records.
- **`package.json`** — added the `multer` dependency.

### Frontend — Website Management
- Each uploader now **uploads the file to the server** (multipart `FormData`),
  receives the stored path, and saves that path on the member record. Buttons
  show an "Uploading…" state while in flight.
- Previews and the team grid resolve `/uploads/...` paths against the backend
  origin (`resolveAsset`).
- The save payload sends `photo_thumbnail` / `photo_full` (paths).

### Frontend — Landing page
- `landing-content.js` resolves the stored `/uploads/...` paths to absolute URLs
  (against the backend origin) before building the carousel, so images load
  regardless of where the page itself is served.
- `landingpage.html` carousel uses `photo_thumbnail` for the card image and
  `photo_full || photo_thumbnail` for the expanded pop-up.

---

## How an administrator adds / replaces a photo
1. **Website Management → Meet the Team → Add / Edit member.**
2. Click **Upload** under *Carousel Photo* and/or *Expanded Photo* and choose a
   file. The file is uploaded to the server immediately and previewed.
3. Fill in name / role / bio and **Save** — only the file path is stored in the
   database; the image itself lives in `backend/uploads/team/…`.

## Setup notes
- Run `npm install` in `backend/` to install **multer** (the only new
  dependency). `node_modules` is excluded from the zip.
- On first startup the migration creates the `team_members` table, seeds the 12
  BPS staff with their file paths, and (for an existing DB) upgrades any older
  Base64 rows to paths.
- The 24 image files ship inside `backend/uploads/team/`. In production you would
  typically point this directory at persistent storage (disk volume / object
  store); the database keeps holding just the path.

## Note on seeded names / roles / bios
As before, the seeded **names, roles, and bios are editable placeholders** based
on the BPS-STAFF filenames. The expanded images are the branded BARCARSE profile
cards from the zip, so each pop-up already shows the member's real credentials;
the text fields below can be corrected anytime in Website Management.
