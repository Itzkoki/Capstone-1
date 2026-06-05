const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorize, authorizeMinRole } = require('../middleware/rbac');
const ctrl = require('../controllers/reportController');

// All routes require authentication
router.use(authenticate);

// ── Psychologist + Clinical Director ───────────────────────────
router.post('/',                         authorizeMinRole('psychologist'), ctrl.createReport);
router.get('/',                          authorizeMinRole('psychologist'), ctrl.listReports);
router.get('/pending-reviews',           authorize('clinical_director'),   ctrl.getPendingReviews);
router.get('/intake-clients',            authorizeMinRole('psychologist'), ctrl.getIntakeClients);
router.get('/audit-logs',               authorize('clinical_director'),   ctrl.getAuditLogs);
router.get('/:id',                       authorizeMinRole('psychologist'), ctrl.getReport);
router.put('/:id',                       authorizeMinRole('psychologist'), ctrl.updateReport);

// ── Assessment & Scores ────────────────────────────────────────
router.post('/:id/assessment',           authorizeMinRole('psychologist'), ctrl.saveAssessmentData);
router.post('/:id/scores',              authorizeMinRole('psychologist'), ctrl.saveTestScore);
router.delete('/:id/scores/:scoreId',   authorizeMinRole('psychologist'), ctrl.deleteTestScore);

// ── Narrative Generation ───────────────────────────────────────
router.post('/:id/generate-narratives', authorizeMinRole('psychologist'), ctrl.generateNarratives);

// ── Section Editing ────────────────────────────────────────────
router.put('/:id/sections/:sectionKey', authorizeMinRole('psychologist'), ctrl.updateSection);

// ── Workflow ───────────────────────────────────────────────────
router.post('/:id/submit',             authorizeMinRole('psychologist'), ctrl.submitReport);
router.post('/:id/approve',            authorize('clinical_director'),   ctrl.approveReport);
router.post('/:id/reject',             authorize('clinical_director'),   ctrl.rejectReport);
router.post('/:id/finalize',           authorize('clinical_director'),   ctrl.finalizeReport);

// ── PDF Export ─────────────────────────────────────────────────
router.get('/:id/pdf',                  authorizeMinRole('psychologist'), ctrl.generatePdf);

// ── Version Control ────────────────────────────────────────────
router.get('/:id/versions',             authorizeMinRole('psychologist'), ctrl.getVersions);
router.post('/:id/versions/:versionId/restore', authorizeMinRole('psychologist'), ctrl.restoreVersion);

// ── E-Signature (in-app placement, embedded into the PDF) ──────
router.post('/:id/esign',                     authorizeMinRole('psychologist'), ctrl.requestEsign);
router.get('/:id/signatures',                 authorizeMinRole('psychologist'), ctrl.listSignatures);
router.delete('/:id/signatures/:signatureId', authorizeMinRole('psychologist'), ctrl.deleteSignature);

module.exports = router;
