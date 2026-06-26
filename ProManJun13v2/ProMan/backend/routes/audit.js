const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');
const {
  getAuditLogs, getAuditTrail, exportAuditLogs, exportAuditTrail, recordEvent,
} = require('../controllers/auditController');
const incidents = require('../controllers/incidentController');

router.use(authenticate);

// Any authenticated user may record their own Logout / Session-Terminated event.
router.post('/event', recordEvent);

// Viewing & exporting the audit data is Clinical-Director only.
const cdOnly = authorize('clinical_director');

router.get('/logs',          cdOnly, getAuditLogs);
router.get('/logs/export',   cdOnly, exportAuditLogs);
router.get('/trail',         cdOnly, getAuditTrail);
router.get('/trail/export',  cdOnly, exportAuditTrail);

// ── Action Management (security incidents) — Clinical-Director only ──────────
// Static paths registered before the :id param route so they aren't shadowed.
router.get('/incidents',            cdOnly, incidents.listIncidents);
router.get('/incidents/stats',      cdOnly, incidents.incidentStats);
router.get('/incidents/catalog',    cdOnly, incidents.getCatalog);
router.get('/incidents/export',     cdOnly, incidents.exportIncidents);
router.get('/incidents/:id',        cdOnly, incidents.getIncident);
router.patch('/incidents/:id/status', cdOnly, incidents.updateStatus);
router.post('/incidents/:id/action',  cdOnly, incidents.recordAction);
router.post('/incidents/:id/note',    cdOnly, incidents.addNote);
router.post('/incidents/:id/escalate', cdOnly, incidents.escalate);
router.post('/incidents/:id/close',   cdOnly, incidents.closeIncident);
router.post('/incidents/:id/reopen',  cdOnly, incidents.reopen);

module.exports = router;
