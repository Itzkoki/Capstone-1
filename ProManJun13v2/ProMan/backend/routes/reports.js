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
router.get('/trash',                     authorize('clinical_director'),   ctrl.getTrash);
router.get('/archive',                   authorizeMinRole('psychologist'), ctrl.getArchive);

// ── Bulk Actions (dashboard) ───────────────────────────────────
router.post('/bulk/delete',              authorizeMinRole('psychologist'), ctrl.bulkDeleteReports);
router.post('/bulk/read',                authorizeMinRole('psychologist'), ctrl.bulkSetReadStatus);
router.post('/bulk/archive',             authorizeMinRole('psychologist'), ctrl.bulkArchiveReports);

router.get('/:id',                       authorizeMinRole('psychologist'), ctrl.getReport);
router.put('/:id',                       authorizeMinRole('psychologist'), ctrl.updateReport);
router.delete('/:id',                    authorizeMinRole('psychologist'), ctrl.deleteReport);

// ── Archive / Trash management ─────────────────────────────────
router.post('/:id/unarchive',            authorizeMinRole('psychologist'), ctrl.unarchiveReport);
router.post('/:id/restore',              authorize('clinical_director'),   ctrl.restoreReport);
router.delete('/:id/permanent',          authorize('clinical_director'),   ctrl.permanentlyDeleteReport);

// ── Assessment Data ────────────────────────────────────────────
router.post('/:id/assessment',           authorizeMinRole('psychologist'), ctrl.saveAssessmentData);

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

// ── E-Signature (DocuSeal) ─────────────────────────────────────
router.post('/:id/esign',                    authorizeMinRole('psychologist'), ctrl.requestEsign);
router.post('/:id/esign/builder',            authorizeMinRole('psychologist'), ctrl.getEsignBuilder);
router.post('/:id/esign/submission',         authorizeMinRole('psychologist'), ctrl.createEsignSubmission);
router.get('/:id/esign/:submissionId',       authorizeMinRole('psychologist'), ctrl.getEsignStatus);

module.exports = router;
