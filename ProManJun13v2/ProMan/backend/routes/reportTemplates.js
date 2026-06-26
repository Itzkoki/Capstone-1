const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorize, authorizeMinRole } = require('../middleware/rbac');
const ctrl = require('../controllers/reportTemplateController');

// All routes require authentication
router.use(authenticate);

// ── Read (Sup.Psy and above) — SupPsy creates reports using templates ──
router.get('/',     authorizeMinRole('supervising_psychometrician'), ctrl.listTemplates);
router.get('/:id', authorizeMinRole('supervising_psychometrician'), ctrl.getTemplate);

// ── CRUD (QC Psychometrician + Clinical Director) ──────────────
router.post('/',    authorize('qc_psychometrician', 'clinical_director'), ctrl.createTemplate);
router.put('/:id', authorize('qc_psychometrician', 'clinical_director'), ctrl.updateTemplate);
router.delete('/:id', authorize('qc_psychometrician', 'clinical_director'), ctrl.deleteTemplate);

module.exports = router;
