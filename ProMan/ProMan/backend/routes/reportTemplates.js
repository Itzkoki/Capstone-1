const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorize, authorizeMinRole } = require('../middleware/rbac');
const ctrl = require('../controllers/reportTemplateController');

// All routes require authentication
router.use(authenticate);

// ── Read (Psychologist + Clinical Director) ────────────────────
router.get('/',     authorizeMinRole('psychologist'), ctrl.listTemplates);
router.get('/:id', authorizeMinRole('psychologist'), ctrl.getTemplate);

// ── CRUD (Clinical Director only) ──────────────────────────────
router.post('/',    authorize('clinical_director'), ctrl.createTemplate);
router.put('/:id', authorize('clinical_director'), ctrl.updateTemplate);
router.delete('/:id', authorize('clinical_director'), ctrl.deleteTemplate);

module.exports = router;
