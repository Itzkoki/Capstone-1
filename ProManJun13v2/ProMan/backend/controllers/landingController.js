const LandingContent = require('../models/LandingContent');
const TeamMember     = require('../models/TeamMember');
const PartnerSchool  = require('../models/PartnerSchool');
const ActivityLog    = require('../models/ActivityLog');

const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
  req.connection?.remoteAddress || req.ip || 'unknown';

// Section keys the CMS knows how to render.
const KNOWN_SECTIONS = ['hero', 'services', 'team', 'mission_vision', 'about', 'cta'];

// Team photos are stored as file PATHS (not Base64), so the stored string is
// short. This cap only guards against absurdly long values.
const MAX_PHOTO_PATH_LEN = 1000;

const str  = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const arr  = (v) => (Array.isArray(v) ? v : []);

/**
 * Whitelist + coerce a content blob per section so the DB only ever
 * stores the shape the landing page knows how to render.
 */
function sanitizeContent(key, raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  switch (key) {
    case 'hero':
      return { headline: str(c.headline, 300), description: str(c.description, 2000) };

    case 'services':
      return {
        label: str(c.label, 120),
        heading: str(c.heading, 200),
        subheading: str(c.subheading, 600),
        cards: arr(c.cards).slice(0, 12).map((x) => {
          const card = x && typeof x === 'object' ? x : {};
          return {
            title: str(card.title, 160),
            text: str(card.text, 600),
            accent: ['blue', 'green', 'violet'].includes(card.accent) ? card.accent : 'blue',
            lead: str(card.lead, 600),
            about: str(card.about, 2000),
            expect: arr(card.expect).slice(0, 12).map((v) => str(v, 200)).filter(Boolean),
            idealFor: arr(card.idealFor).slice(0, 12).map((v) => str(v, 120)).filter(Boolean),
            faqs: arr(card.faqs).slice(0, 12).map((q) => ({
              q: str(q && q.q, 240),
              a: str(q && q.a, 1200),
            })).filter((q) => q.q || q.a),
          };
        }),
      };

    case 'team':
      return {
        label: str(c.label, 120),
        heading: str(c.heading, 200),
        subheading: str(c.subheading, 600),
      };

    case 'mission_vision':
      return {
        label: str(c.label, 120),
        heading: str(c.heading, 200),
        subheading: str(c.subheading, 600),
        vision_title: str(c.vision_title, 120),
        vision_text: str(c.vision_text, 4000),
        vision_image: str(c.vision_image, 1000),
        values: arr(c.values).slice(0, 40).map((v) => str(v, 80)).filter(Boolean),
        mission_title: str(c.mission_title, 120),
        mission_text: str(c.mission_text, 4000),
        mission_image: str(c.mission_image, 1000),
        goals: arr(c.goals).slice(0, 30).map((v) => str(v, 600)).filter(Boolean),
        history_title: str(c.history_title, 120),
        history_text: str(c.history_text, 6000),
        contact_email: str(c.contact_email, 200),
        contact_phone: str(c.contact_phone, 200),
        contact_phone2: str(c.contact_phone2, 200),
      };

    // The `about` slot powers the live "Our Facilities" carousel. It holds an
    // eyebrow/heading/subheading plus a dynamic list of facility photo + caption
    // pairs. Staff can add/delete facilities (no fixed count, capped at 30).
    // Stored canonically as a `facilities` array; legacy fac1..N_* keys are
    // still accepted on input for backward compatibility.
    case 'about': {
      const out = {
        label: str(c.label, 120),
        heading: str(c.heading, 200),
        subheading: str(c.subheading, 600),
      };
      let list = [];
      if (Array.isArray(c.facilities)) {
        list = c.facilities.map((f) => {
          const it = f && typeof f === 'object' ? f : {};
          return { image: str(it.image, 1000), caption: str(it.caption, 160) };
        });
      } else {
        // Legacy flat keys: fac1_image / fac1_caption, fac2_image, …
        for (let i = 1; i <= 30; i++) {
          if (c[`fac${i}_image`] === undefined && c[`fac${i}_caption`] === undefined) continue;
          list.push({ image: str(c[`fac${i}_image`], 1000), caption: str(c[`fac${i}_caption`], 160) });
        }
      }
      out.facilities = list.filter((f) => f.image || f.caption).slice(0, 30);
      return out;
    }

    case 'cta':
      return {
        label: str(c.label, 120),
        heading: str(c.heading, 200),
        subheading: str(c.subheading, 600),
        primary_label: str(c.primary_label, 60),
        secondary_label: str(c.secondary_label, 60),
      };

    default:
      return {};
  }
}

// ── PUBLIC: everything the landing page needs to render ─────────
const getPublicLanding = async (_req, res, next) => {
  try {
    const [sections, content, team, partners] = await Promise.all([
      LandingContent.getSections(),
      LandingContent.getAllContent(),
      TeamMember.findVisible(),
      PartnerSchool.findEnabled(),
    ]);
    return res.json({
      success: true,
      data: {
        sections: sections.filter((s) => s.is_visible),
        content,
        team,
        partners,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── CD: full management snapshot (incl. hidden items) ───────────
const getAdminLanding = async (_req, res, next) => {
  try {
    const [sections, content, team, partners] = await Promise.all([
      LandingContent.getSections(),
      LandingContent.getAllContent(),
      TeamMember.findAll(),
      PartnerSchool.findAll(),
    ]);
    return res.json({ success: true, data: { sections, content, team, partners } });
  } catch (err) {
    next(err);
  }
};

// ── CD: save one section's content ──────────────────────────────
const updateContent = async (req, res, next) => {
  try {
    const { key } = req.params;
    if (!KNOWN_SECTIONS.includes(key)) {
      return res.status(400).json({ success: false, message: 'Unknown section.' });
    }
    const clean = sanitizeContent(key, req.body.content ?? req.body);
    const saved = await LandingContent.saveContent(key, clean, req.user.id);

    await ActivityLog.log(req.user.id, 'EDIT_LANDING_SECTION', 'landing_content', null,
      getClientIP(req), { section: key });

    return res.json({ success: true, message: 'Section updated.', data: saved });
  } catch (err) {
    next(err);
  }
};

// ── CD: reorder sections ────────────────────────────────────────
const reorderSections = async (req, res, next) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || !order.length) {
      return res.status(400).json({ success: false, message: 'order[] is required.' });
    }
    await LandingContent.reorderSections(order);
    await ActivityLog.log(req.user.id, 'REORDER_LANDING_SECTIONS', 'landing_sections', null,
      getClientIP(req), { order });
    const sections = await LandingContent.getSections();
    return res.json({ success: true, message: 'Sections reordered.', data: sections });
  } catch (err) {
    next(err);
  }
};

// ── CD: show / hide a section ───────────────────────────────────
const toggleSection = async (req, res, next) => {
  try {
    const { key } = req.params;
    const { is_visible } = req.body;
    const updated = await LandingContent.setVisibility(key, is_visible !== false);
    if (!updated) return res.status(404).json({ success: false, message: 'Section not found.' });
    await ActivityLog.log(req.user.id, 'TOGGLE_LANDING_SECTION', 'landing_sections', updated.id,
      getClientIP(req), { section: key, is_visible: updated.is_visible });
    return res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// ── CD: Team member CRUD ────────────────────────────────────────
// Photos are now stored as file PATHS produced by the upload endpoint
// (e.g. /uploads/team/thumbs/x.jpg). For resilience we also accept absolute
// http(s) URLs. Anything else (including Base64 data: URLs) is rejected — the
// image must be uploaded as a real file first.
function validatePhotoPath(value) {
  if (value === undefined || value === null || value === '') return null; // clears
  if (typeof value !== 'string') return false;
  if (value.length > MAX_PHOTO_PATH_LEN) return false;
  const ok = value.startsWith('/uploads/team/') || /^https?:\/\//.test(value);
  return ok ? value : false;
}

const createTeamMember = async (req, res, next) => {
  try {
    const { name, role, bio, is_visible } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required.' });
    }
    const photo_thumbnail = validatePhotoPath(req.body.photo_thumbnail);
    if (photo_thumbnail === false) {
      return res.status(400).json({ success: false, message: 'Invalid thumbnail path — upload the image first.' });
    }
    const photo_full = validatePhotoPath(req.body.photo_full);
    if (photo_full === false) {
      return res.status(400).json({ success: false, message: 'Invalid expanded-photo path — upload the image first.' });
    }
    const member = await TeamMember.create({
      name: str(name, 160), role: str(role, 160), bio: str(bio, 1000),
      photo_thumbnail, photo_full, is_visible,
    });
    await ActivityLog.log(req.user.id, 'ADD_TEAM_MEMBER', 'team_member', member.id,
      getClientIP(req), { name: member.name });
    return res.status(201).json({ success: true, message: 'Team member added.', data: member });
  } catch (err) {
    next(err);
  }
};

const updateTeamMember = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await TeamMember.findById(id);
    if (!existing) return res.status(404).json({ success: false, message: 'Member not found.' });

    const fields = {};
    if (req.body.name !== undefined) fields.name = str(req.body.name, 160);
    if (req.body.role !== undefined) fields.role = str(req.body.role, 160);
    if (req.body.bio !== undefined) fields.bio = str(req.body.bio, 1000);
    if (req.body.is_visible !== undefined) fields.is_visible = req.body.is_visible !== false;
    if (req.body.photo_thumbnail !== undefined) {
      const photo_thumbnail = validatePhotoPath(req.body.photo_thumbnail);
      if (photo_thumbnail === false) {
        return res.status(400).json({ success: false, message: 'Invalid thumbnail path — upload the image first.' });
      }
      fields.photo_thumbnail = photo_thumbnail; // null clears the thumbnail
    }
    if (req.body.photo_full !== undefined) {
      const photo_full = validatePhotoPath(req.body.photo_full);
      if (photo_full === false) {
        return res.status(400).json({ success: false, message: 'Invalid expanded-photo path — upload the image first.' });
      }
      fields.photo_full = photo_full; // null clears the expanded photo
    }

    const member = await TeamMember.update(id, fields);
    await ActivityLog.log(req.user.id, 'EDIT_TEAM_MEMBER', 'team_member', id,
      getClientIP(req), { name: member.name });
    return res.json({ success: true, message: 'Team member updated.', data: member });
  } catch (err) {
    next(err);
  }
};

const deleteTeamMember = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await TeamMember.findById(id);
    if (!existing) return res.status(404).json({ success: false, message: 'Member not found.' });
    await TeamMember.deleteById(id);
    await ActivityLog.log(req.user.id, 'DELETE_TEAM_MEMBER', 'team_member', id,
      getClientIP(req), { name: existing.name });
    return res.json({ success: true, message: 'Team member removed.' });
  } catch (err) {
    next(err);
  }
};

const reorderTeam = async (req, res, next) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) {
      return res.status(400).json({ success: false, message: 'order[] is required.' });
    }
    await TeamMember.reorder(order.map((x) => parseInt(x, 10)));
    const team = await TeamMember.findAll();
    return res.json({ success: true, message: 'Team reordered.', data: team });
  } catch (err) {
    next(err);
  }
};

// ── CD: Upload a team photo file (thumbnail or full) ────────────
// Multer (configured in the route) has already written the file to
// backend/uploads/team/{thumbs,full}/. We just return the public path so the
// Website Management UI can store it on the member record.
const uploadTeamPhoto = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image file received.' });
  }
  const kind = req.query.kind === 'full' ? 'full' : 'thumbs';
  const urlPath = `/uploads/team/${kind}/${req.file.filename}`;
  try {
    await ActivityLog.log(req.user.id, 'UPLOAD_TEAM_PHOTO', 'team_member', null,
      getClientIP(req), { kind, file: req.file.filename });
  } catch (_) { /* logging is best-effort */ }
  return res.json({ success: true, message: 'Image uploaded.', data: { path: urlPath } });
};

// ── CD: Partner Schools CRUD ────────────────────────────────────
const MAX_LOGO_PATH_LEN = 1000;

function validateLogoPath(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return false;
  if (value.length > MAX_LOGO_PATH_LEN) return false;
  const ok = value.startsWith('/uploads/partners/')
           || value.startsWith('/partnership-school-logos/')
           || /^https?:\/\//.test(value);
  return ok ? value : false;
}

const createPartnerSchool = async (req, res, next) => {
  try {
    const { school_name, is_enabled } = req.body;
    if (!school_name || !school_name.trim()) {
      return res.status(400).json({ success: false, message: 'School name is required.' });
    }
    const logo_path = validateLogoPath(req.body.logo_path);
    if (logo_path === false) {
      return res.status(400).json({ success: false, message: 'Invalid logo path — upload the logo first.' });
    }
    const partner = await PartnerSchool.create({
      school_name: str(school_name, 200),
      logo_path,
      is_enabled: is_enabled !== false,
    });
    await ActivityLog.log(req.user.id, 'ADD_PARTNER_SCHOOL', 'partner_schools', partner.id,
      getClientIP(req), { name: partner.school_name });
    return res.status(201).json({ success: true, message: 'Partner school added.', data: partner });
  } catch (err) {
    next(err);
  }
};

const updatePartnerSchool = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await PartnerSchool.findById(id);
    if (!existing) return res.status(404).json({ success: false, message: 'Partner school not found.' });

    const fields = {};
    if (req.body.school_name !== undefined) fields.school_name = str(req.body.school_name, 200);
    if (req.body.is_enabled  !== undefined) fields.is_enabled  = req.body.is_enabled !== false;
    if (req.body.logo_path   !== undefined) {
      const logo_path = validateLogoPath(req.body.logo_path);
      if (logo_path === false) {
        return res.status(400).json({ success: false, message: 'Invalid logo path — upload the logo first.' });
      }
      fields.logo_path = logo_path;
    }

    const partner = await PartnerSchool.update(id, fields);
    await ActivityLog.log(req.user.id, 'EDIT_PARTNER_SCHOOL', 'partner_schools', id,
      getClientIP(req), { name: partner.school_name });
    return res.json({ success: true, message: 'Partner school updated.', data: partner });
  } catch (err) {
    next(err);
  }
};

const deletePartnerSchool = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await PartnerSchool.findById(id);
    if (!existing) return res.status(404).json({ success: false, message: 'Partner school not found.' });
    await PartnerSchool.deleteById(id);
    await ActivityLog.log(req.user.id, 'DELETE_PARTNER_SCHOOL', 'partner_schools', id,
      getClientIP(req), { name: existing.school_name });
    return res.json({ success: true, message: 'Partner school removed.' });
  } catch (err) {
    next(err);
  }
};

const reorderPartnerSchools = async (req, res, next) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) {
      return res.status(400).json({ success: false, message: 'order[] is required.' });
    }
    await PartnerSchool.reorder(order.map((x) => parseInt(x, 10)));
    const partners = await PartnerSchool.findAll();
    return res.json({ success: true, message: 'Partners reordered.', data: partners });
  } catch (err) {
    next(err);
  }
};

const uploadPartnerLogo = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image file received.' });
  }
  const urlPath = `/uploads/partners/${req.file.filename}`;
  try {
    await ActivityLog.log(req.user.id, 'UPLOAD_PARTNER_LOGO', 'partner_schools', null,
      getClientIP(req), { file: req.file.filename });
  } catch (_) {}
  return res.json({ success: true, message: 'Logo uploaded.', data: { path: urlPath } });
};

module.exports = {
  getPublicLanding,
  getAdminLanding,
  updateContent,
  reorderSections,
  toggleSection,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
  reorderTeam,
  uploadTeamPhoto,
  createPartnerSchool,
  updatePartnerSchool,
  deletePartnerSchool,
  reorderPartnerSchools,
  uploadPartnerLogo,
};
