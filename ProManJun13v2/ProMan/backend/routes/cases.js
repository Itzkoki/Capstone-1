const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorize, authorizeMinRole } = require('../middleware/rbac');
const caseCtrl = require('../controllers/caseController');

// ─── All case routes require authentication ────────────────────────

// List cases — clients see their own, staff see based on role
router.get('/', authenticate, caseCtrl.getCases);

// Archived cases — must be before /:caseId to avoid param conflict
router.get('/archived',
  authenticate,
  authorize('clinical_director'),
  caseCtrl.getArchivedCases
);

// Case detail (full joined view)
router.get('/:caseId', authenticate, caseCtrl.getCaseById);

// ─── Intake Review (Phase 2) — only the Psychometrician (or Clinical Director) can approve/reject intake
router.post('/:caseId/review',
  authenticate,
  authorize('psychometrician', 'clinical_director'),
  caseCtrl.reviewIntake
);

// ─── Payment Verification (Phase 3) — Supervising Psychometrician confirms payment received
router.post('/:caseId/payment/verify',
  authenticate,
  authorizeMinRole('supervising_psychometrician'),
  caseCtrl.verifyPayment
);

// ─── Scheduling (Phase 4) — Supervising Psychometrician schedules
router.post('/:caseId/schedule',
  authenticate,
  authorizeMinRole('supervising_psychometrician'),
  caseCtrl.scheduleAppointment
);

// ─── Assessment (Phase 5) ──────────────────────────────────────────
router.post('/:caseId/assessment/start',
  authenticate,
  authorizeMinRole('psychologist'),
  caseCtrl.startAssessment
);
router.post('/:caseId/assessment/complete',
  authenticate,
  authorizeMinRole('psychologist'),
  caseCtrl.completeAssessment
);

// ─── Report Submission & Approval (Phases 6–7) ─────────────────────
router.post('/:caseId/report/submit',
  authenticate,
  authorizeMinRole('psychologist'),
  caseCtrl.submitReportForApproval
);
router.post('/:caseId/report/approve',
  authenticate,
  authorizeMinRole('psychologist'),
  caseCtrl.approveReport
);
router.post('/:caseId/report/reject',
  authenticate,
  authorizeMinRole('psychologist'),
  caseCtrl.rejectReport
);

// ─── Report Release (Phase 11) ─────────────────────────────────────
// Supervising Psychometrician releases to client; CD can override
router.post('/:caseId/report/release',
  authenticate,
  authorizeMinRole('supervising_psychometrician'),
  caseCtrl.releaseReport
);

// ─── Close Case (Phase 12) ─────────────────────────────────────────
router.post('/:caseId/close',
  authenticate,
  authorize('clinical_director'),
  caseCtrl.closeCase
);

// ─── Case Notes ────────────────────────────────────────────────────
router.post('/:caseId/notes', authenticate, caseCtrl.addNote);
router.get('/:caseId/notes', authenticate, caseCtrl.getNotes);

// ─── Audit Trail ───────────────────────────────────────────────────
router.get('/:caseId/audit',
  authenticate,
  authorizeMinRole('psychologist'),
  caseCtrl.getAuditTrail
);

// ─── Reassign Psychologist ─────────────────────────────────────────
router.post('/:caseId/reassign',
  authenticate,
  authorize('clinical_director'),
  caseCtrl.reassignPsychologist
);

// ─── No-Show Handling ──────────────────────────────────────────────
router.post('/:caseId/no-show',
  authenticate,
  authorizeMinRole('psychologist'),
  caseCtrl.handleNoShow
);

// ─── Archive Case (CD only) ────────────────────────────────────────
router.delete('/:caseId',
  authenticate,
  authorize('clinical_director'),
  caseCtrl.deleteCase
);

// ─── Restore Archived Case (CD only) ──────────────────────────────
router.post('/:caseId/restore',
  authenticate,
  authorize('clinical_director'),
  caseCtrl.restoreCase
);

// ─── Permanent Delete — bulk (must be before /:caseId/permanent) ──
router.delete('/permanent/bulk',
  authenticate,
  authorize('clinical_director'),
  caseCtrl.permanentDeleteCases
);

// ─── Permanent Delete — single archived case (CD only) ────────────
router.delete('/:caseId/permanent',
  authenticate,
  authorize('clinical_director'),
  caseCtrl.permanentDeleteCase
);

module.exports = router;
