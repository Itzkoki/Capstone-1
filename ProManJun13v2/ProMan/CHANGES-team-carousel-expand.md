# Landing Page Carousel — Image Expansion Enhancement

Clicking a staff member's cropped photo in the "Meet the Team" carousel now opens
a modal/pop-up showing a **larger (full) version** of that member's image, with the
member's **full name, role title, and short bio retained directly below the picture**.
Both the cropped carousel image and the full expanded image are fully editable from
the Website Management module — no code changes required to update staff.

---

## What changed

### Data model — a second photo per member
Each team member now stores two images:

| Field        | Purpose                                              |
|--------------|------------------------------------------------------|
| `photo`      | Cropped thumbnail shown in the carousel (existing)   |
| `photo_full` | Larger image shown in the click-to-expand pop-up (new) |

If a member has no `photo_full`, the pop-up gracefully falls back to the cropped
`photo`, and then to an initials placeholder.

### Backend (`/backend`)
- **`migrations.js`**
  - Added `photo_full TEXT` to the `team_members` table.
  - Added `ALTER TABLE team_members ADD COLUMN IF NOT EXISTS photo_full TEXT` so
    existing databases upgrade automatically on the next startup.
  - The team seed now loads the real BPS staff line-up (paired crop + full images)
    from `backend/seed/team-seed.json`. If the file is missing it falls back to the
    original text-only defaults.
- **`models/TeamMember.js`** — `photo_full` is included in `findVisible`, `findAll`,
  `create`, and the allowed `update` fields.
- **`controllers/landingController.js`** — validates and accepts `photo_full` on
  create/update. The expanded image is allowed a larger size cap (`MAX_PHOTO_FULL_LEN`
  = 4 MB) than the small carousel crop, since it is shown at full size.
- **`backend/seed/team-seed.json`** *(new)* — 12 BPS staff, each with a downscaled
  crop (~20 KB) and full (~135 KB) image baked in as data-URLs.

### Public landing page
- **`landingpage.html`**
  - Carousel cards are now clickable (mouse **and** keyboard — `Enter`/`Space`),
    with an "expand" affordance shown on hover/focus and an accessible label.
  - New **expanded staff profile modal**: full picture on top, then the retained
    name / role / bio below. Closes via the × button, backdrop click, or `Escape`,
    restores focus to the card, and locks background scroll while open.
  - `landing-content.js` already forwards the full team list (now including
    `photo_full`) to the carousel, so the correct details always match the photo.
- **`landing-redesign.css`**
  - Clickable-card affordance (cursor, hover gradient, expand badge, focus ring).
  - Expanded-profile modal styling with smooth open/close animations, a portrait
    media area, responsive mobile breakpoints, and `prefers-reduced-motion` support.

### Website Management module
- **`website-management.html` / `website-management.css`**
  - The Add/Edit Team Member modal now has **two uploaders side by side**:
    *Carousel Photo* (cropped thumbnail) and *Expanded Photo* (shown when clicked).
  - Both upload, replace, and clear independently and save together.
  - The expanded image is downscaled to a larger max dimension (900 px) to keep
    detail in the pop-up while staying lightweight.
  - The team grid shows an **"⤢ Expanded" / "No expanded"** badge per member so the
    administrator can see at a glance who still needs a full photo.

---

## How an administrator uses it
1. Go to **Website Management → Meet the Team**.
2. Click **Add Member** (or edit an existing one).
3. Upload a **Carousel Photo** (the cropped thumbnail) and an **Expanded Photo**
   (the larger picture for the pop-up). Either can be replaced or removed later.
4. Fill in **Full Name**, **Role / Title**, and **Short Bio**, then save.
5. On the public landing page, visitors click the cropped photo to see the full
   image with that member's details below.

---

## Note on seeded names / roles / bios
The 12 members are seeded from the **BPS-STAFF** image set. The **names, roles, and
short bios are sensible placeholders** derived from the image filenames — they are
meant to be reviewed and corrected by an administrator in Website Management. The
expanded images themselves are the branded BARCARSE profile cards supplied in the
zip, so each pop-up already displays the member's real credentials; the editable
text fields below simply mirror them and can be adjusted at any time.
