const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorizeMinRole } = require('../middleware/rbac');
const {
  createRequest, getRequests, getRequest, getRequestFile,
  assignRequest, updateRequestStatus,
  promptPayment, uploadRequestPaymentProof, verifyRequestPayment,
  uploadRequestReport, replyToRequest, getReleasedReports,
  listReportRequests, reviewRequest, sendReport, getRequestAudit,
  listLegacyVerifications, legacyVerify,
} = require('../controllers/requestController');

const {
  listReportConcerns, reviewConcern, saveConcernVersion, getConcernVersions,
  submitModifiedReport, finalReviewConcern,
} = require('../controllers/reportConcernController');

router.use(authenticate);

// Client
router.post('/',                    createRequest);
router.get('/released-reports',     getReleasedReports);
router.post('/:id/payment-proof',   uploadRequestPaymentProof);
router.post('/:id/reply',           replyToRequest);

// Report Requests (Clinical Director) — registered before '/:id' so the
// literal path is not captured by the ':id' parameter route.
router.get('/report-requests',      authorizeMinRole('clinical_director'), listReportRequests);
router.put('/:id/review',           authorizeMinRole('clinical_director'), reviewRequest);
router.post('/:id/send',            authorizeMinRole('clinical_director'), sendReport);

// Legacy report verification (old/physical reports not in the system) — CD only.
// Registered before '/:id' so the literal path isn't captured by ':id'.
router.get('/legacy-verifications', authorizeMinRole('clinical_director'), listLegacyVerifications);
router.put('/:id/legacy-verify',    authorizeMinRole('clinical_director'), legacyVerify);

// Report Concerns
router.get('/report-concerns',      authorizeMinRole('clinical_director'), listReportConcerns);
router.put('/:id/concern-review',   authorizeMinRole('clinical_director'), reviewConcern);   // CD approve/reject
router.put('/:id/concern-final',    authorizeMinRole('clinical_director'), finalReviewConcern); // CD release/request-revision
// The report's AUTHOR (or CD) uploads the modified PDF + submits it. Authors can
// be any clinical authoring role (psychologist OR supervising/qc psychometrician),
// so the route floor is supervising_psychometrician; the controller then enforces
// that the caller is the actual report author (assigned_psychologist_id) or CD.
router.post('/:id/concern-version', authorizeMinRole('supervising_psychometrician'), saveConcernVersion);
router.post('/:id/concern-submit',  authorizeMinRole('supervising_psychometrician'), submitModifiedReport);
router.get('/:id/concern-versions', getConcernVersions);

// Shared
router.get('/',                     getRequests);
router.get('/:id',                  getRequest);
router.get('/:id/file',             getRequestFile);
router.get('/:id/audit',            getRequestAudit);

// Staff
router.put('/:id/assign',           authorizeMinRole('clinical_director'), assignRequest);
router.put('/:id/status',           authorizeMinRole('psychometrician'), updateRequestStatus);
router.put('/:id/payment-prompt',   authorizeMinRole('psychometrician'), promptPayment);
router.put('/:id/payment-verify',   authorizeMinRole('clinical_director'), verifyRequestPayment);
router.post('/:id/report',          authorizeMinRole('psychometrician'), uploadRequestReport);

module.exports = router;
