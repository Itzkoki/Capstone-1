const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { authenticate } = require('../middleware/auth');
const { authorize }    = require('../middleware/rbac');
const {
  getPublicLanding, getAdminLanding, updateContent,
  reorderSections, toggleSection,
  createTeamMember, updateTeamMember, deleteTeamMember, reorderTeam,
  uploadTeamPhoto,
  createPartnerSchool, updatePartnerSchool, deletePartnerSchool, reorderPartnerSchools,
  uploadPartnerLogo,
} = require('../controllers/landingController');

// ── PUBLIC ──────────────────────────────────────────────
// Consumed by the public landing page (no auth required).
router.get('/public', getPublicLanding);

// ── CLINICAL DIRECTOR ONLY ──────────────────────────────
router.use(authenticate);
router.use(authorize('clinical_director'));

router.get('/admin',                getAdminLanding);

// Section content + ordering + visibility
router.put('/sections/order',       reorderSections);
router.put('/sections/:key/visibility', toggleSection);
router.put('/content/:key',         updateContent);

// ── Team photo upload (writes a real file to disk) ──────
// POST /api/landing/team/upload?kind=thumb|full  (multipart field: "image")
// Returns { data: { path: "/uploads/team/thumbs/<file>.jpg" } } which the
// Website Management UI then stores on the member record.
const TEAM_DIR = path.join(__dirname, '..', 'uploads', 'team');
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const sub = req.query.kind === 'full' ? 'full' : 'thumbs';
    const dir = path.join(TEAM_DIR, sub);
    try { ensureDir(dir); cb(null, dir); } catch (e) { cb(e); }
  },
  filename(_req, file, cb) {
    const m = (file.originalname || '').toLowerCase().match(/\.(jpe?g|png|webp|gif)$/);
    const ext = m ? m[0] : '.jpg';
    cb(null, `team-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const uploadTeamImage = multer({
  storage,
  fileFilter(_req, file, cb) {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB per image
}).single('image');

router.post('/team/upload', (req, res, next) => {
  uploadTeamImage(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    return uploadTeamPhoto(req, res, next);
  });
});

// Team members
router.post('/team',                createTeamMember);
router.put('/team/order',           reorderTeam);
router.put('/team/:id',             updateTeamMember);
router.delete('/team/:id',          deleteTeamMember);

// ── Partner School logo upload ──────────────────────────────────
const PARTNER_DIR = path.join(__dirname, '..', 'uploads', 'partners');

const partnerLogoStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    try { ensureDir(PARTNER_DIR); cb(null, PARTNER_DIR); } catch (e) { cb(e); }
  },
  filename(_req, file, cb) {
    const m = (file.originalname || '').toLowerCase().match(/\.(jpe?g|png|webp|gif)$/);
    const ext = m ? m[0] : '.png';
    cb(null, `partner-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const uploadPartnerImage = multer({
  storage: partnerLogoStorage,
  fileFilter(_req, file, cb) {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('image');

router.post('/partners/upload', (req, res, next) => {
  uploadPartnerImage(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    return uploadPartnerLogo(req, res, next);
  });
});

// Partner schools CRUD
router.post('/partners',            createPartnerSchool);
router.put('/partners/order',       reorderPartnerSchools);
router.put('/partners/:id',         updatePartnerSchool);
router.delete('/partners/:id',      deletePartnerSchool);

module.exports = router;
