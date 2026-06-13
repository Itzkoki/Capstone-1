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
  listReportConcerns, reviewConcern, saveConcernVersion, getConcernVersions, submitConcernInfo,
} = require('../controllers/requestController');

router.use(authenticate);

// Client
router.post('/',                    createRequest);
router.get('/released-reports',     getReleasedReports);
router.post('/:id/payment-proof',   uploadRequestPaymentProof);
router.post('/:id/reply',           replyToRequest);
router.post('/:id/concern-info',    submitConcernInfo);

// Report Requests (Clinical Director) — registered before '/:id' so the
// literal path is not captured by the ':id' parameter route.
router.get('/report-requests',      authorizeMinRole('clinical_director'), listReportRequests);
router.put('/:id/review',           authorizeMinRole('clinical_director'), reviewRequest);
router.post('/:id/send',            authorizeMinRole('clinical_director'), sendReport);

// Report Concerns (Clinical Director)
router.get('/report-concerns',      authorizeMinRole('clinical_director'), listReportConcerns);
router.put('/:id/concern-review',   authorizeMinRole('clinical_director'), reviewConcern);
router.post('/:id/concern-version', authorizeMinRole('clinical_director'), saveConcernVersion);
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
