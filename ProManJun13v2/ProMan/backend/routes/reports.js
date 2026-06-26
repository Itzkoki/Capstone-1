const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorize, authorizeMinRole } = require('../middleware/rbac');
const ctrl = require('../controllers/reportController');

// All routes require authentication
router.use(authenticate);

// ── Client-facing (released reports) ───────────────────────────
// Authenticated clients can list and download reports released to them.
// Declared before '/:id' so it is not captured by the param route.
router.get('/my-released',               ctrl.listMyReleased);

// ── All Staff + Clinical Director ──────────────────────────────
router.post('/',                         authorizeMinRole('supervising_psychometrician'), ctrl.createReport);
router.get('/',                          authorizeMinRole('supervising_psychometrician'), ctrl.listReports);
router.get('/pending-reviews',           authorize('clinical_director'),   ctrl.getPendingReviews);
router.get('/intake-clients',            authorizeMinRole('supervising_psychometrician'), ctrl.getIntakeClients);
router.get('/audit-logs',               authorize('clinical_director'),   ctrl.getAuditLogs);
router.get('/trash',                     authorize('clinical_director'),   ctrl.getTrash);
router.get('/archive',                   authorizeMinRole('supervising_psychometrician'), ctrl.getArchive);

// ── Bulk Actions (dashboard) ───────────────────────────────────
router.post('/bulk/delete',              authorizeMinRole('supervising_psychometrician'), ctrl.bulkDeleteReports);
router.post('/bulk/read',                authorizeMinRole('supervising_psychometrician'), ctrl.bulkSetReadStatus);
router.post('/bulk/archive',             authorizeMinRole('supervising_psychometrician'), ctrl.bulkArchiveReports);

router.get('/:id',                       authorizeMinRole('supervising_psychometrician'), ctrl.getReport);
router.put('/:id',                       authorizeMinRole('supervising_psychometrician'), ctrl.updateReport);
router.delete('/:id',                    authorizeMinRole('supervising_psychometrician'), ctrl.deleteReport);

// ── Archive / Trash management ─────────────────────────────────
router.post('/:id/unarchive',            authorizeMinRole('supervising_psychometrician'), ctrl.unarchiveReport);
router.post('/:id/restore',              authorize('clinical_director'),   ctrl.restoreReport);
router.delete('/:id/permanent',          authorize('clinical_director'),   ctrl.permanentlyDeleteReport);

// ── Assessment Data ────────────────────────────────────────────
router.post('/:id/assessment',           authorizeMinRole('supervising_psychometrician'), ctrl.saveAssessmentData);

// ── Narrative Generation ───────────────────────────────────────
router.post('/:id/generate-narratives', authorizeMinRole('supervising_psychometrician'), ctrl.generateNarratives);

// ── Section Editing ────────────────────────────────────────────
router.put('/:id/sections/:sectionKey', authorizeMinRole('supervising_psychometrician'), ctrl.updateSection);

// ── Workflow (legacy) ──────────────────────────────────────────
router.post('/:id/submit',             authorizeMinRole('supervising_psychometrician'), ctrl.submitReport);
router.post('/:id/approve',            authorize('clinical_director'),   ctrl.approveReport);
router.post('/:id/reject',             authorize('clinical_director'),   ctrl.rejectReport);
router.post('/:id/finalize',           authorize('clinical_director'),   ctrl.finalizeReport);

// ── 3-Stage Workflow: Prepared → Review → Approved ────────────
// SupPsy marks report ready for QC (report: draft → Prepared; case: Assessment Completed → Report Drafting)
router.post('/:id/workflow/prepare',  authorize('supervising_psychometrician'), ctrl.workflowPrepare);
// QCP completes review (report: Prepared → Review; case: Report Drafting → Awaiting Director Approval)
router.post('/:id/workflow/review',   authorize('qc_psychometrician'),          ctrl.workflowReview);
// QCP requests revision (report: Prepared → revision_requested_qc; notifies SupPsy)
router.post('/:id/workflow/qc-revise', authorize('qc_psychometrician'),         ctrl.workflowQcRevise);
// Psychologist approves (report: Review → Approved; case: Awaiting Director Approval → Report Approved)
router.post('/:id/workflow/approve',  authorize('psychologist'),                ctrl.workflowApprove);
// Psychologist approves their OWN authored draft (solo flow): draft → Approved + signature_stage 'psychologist'
router.post('/:id/workflow/psychologist-approve', authorize('psychologist'),    ctrl.psychologistApprove);
// Psychologist requests revision (report: Review → revision_requested; notifies SupPsy)
router.post('/:id/workflow/revise',   authorize('psychologist'),                ctrl.workflowRevise);
// QCP or SupPsy resubmits after revision (revision_requested → Review; revision_requested_qc → Prepared)
router.post('/:id/workflow/resubmit', authorize('qc_psychometrician', 'supervising_psychometrician'), ctrl.workflowResubmit);
// CD can lock/unlock a report to prevent further edits
router.post('/:id/workflow/lock',     authorize('clinical_director'),           ctrl.workflowLock);

// ── PDF Export ─────────────────────────────────────────────────
router.get('/:id/pdf',                  authorizeMinRole('supervising_psychometrician'), ctrl.generatePdf);
// Client downloads the final signed PDF of a report released to them.
router.get('/:id/client-pdf',           ctrl.getClientPdf);

// ── Signature & Release Workflow ───────────────────────────────
// Supervising / QC / Psychologist save their signed PDF (persisted as a new version)
router.post('/:id/save-signed-pdf', authorize('supervising_psychometrician', 'qc_psychometrician', 'psychologist'), ctrl.saveSignedPdf);
// Supervising hands off to QC (requires a saved signed PDF)
router.post('/:id/submit-to-qc',    authorize('supervising_psychometrician'), ctrl.submitToQc);
// QC hands off to the Psychologist for signing (button: "Submit to Psychologist")
router.post('/:id/mark-signed',     authorize('qc_psychometrician'), ctrl.markSigned);
// Psychologist hands off to the Clinical Director → Ready For Release
router.post('/:id/submit-to-director', authorize('psychologist'), ctrl.submitToDirector);
// Clinical Director releases the final signed PDF to the client
router.post('/:id/release',         authorize('clinical_director'), ctrl.release);

// ── Version Control ────────────────────────────────────────────
router.get('/:id/versions',             authorizeMinRole('supervising_psychometrician'), ctrl.getVersions);
router.post('/:id/versions/:versionId/restore', authorizeMinRole('supervising_psychometrician'), ctrl.restoreVersion);

// ── E-Signature (DocuSeal) ─────────────────────────────────────
router.post('/:id/esign',                    authorizeMinRole('supervising_psychometrician'), ctrl.requestEsign);
router.post('/:id/esign/builder',            authorizeMinRole('supervising_psychometrician'), ctrl.getEsignBuilder);
router.post('/:id/esign/submission',         authorizeMinRole('supervising_psychometrician'), ctrl.createEsignSubmission);
router.get('/:id/esign/:submissionId',       authorizeMinRole('supervising_psychometrician'), ctrl.getEsignStatus);

module.exports = router;
