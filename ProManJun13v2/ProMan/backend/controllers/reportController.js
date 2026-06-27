const PsychologicalReport = require('../models/PsychologicalReport');
const securityEvents       = require('../services/securityEvents');
const ReportSignedPdf      = require('../models/ReportSignedPdf');
const ReportTemplate       = require('../models/ReportTemplate');
const Case                 = require('../models/Case');
const RuleEngine           = require('../services/ruleEngine');
const PdfGenerator         = require('../services/pdfGenerator');
const DocuSealService      = require('../services/docusealService');
const ReportAudit          = require('../services/reportAuditService');
const NotificationService  = require('../services/notificationService');
const db                   = require('../config/db');

// ── Create Report ──────────────────────────────────────────────
exports.createReport = async (req, res) => {
  try {
    // The Quality Control Psychometrician may never create reports — they are a
    // review/signature role only. (They sit above Supervising in the hierarchy,
    // so the route's min-role check alone would let them through.)
    if (req.user.role === 'qc_psychometrician') {
      return res.status(403).json({ success: false, message: 'Quality Control Psychometricians cannot create reports.' });
    }

    const { template_id, client_name, client_age, client_gender, date_of_assessment, case_id, client_id } = req.body;
    if (!template_id || !client_name) {
      return res.status(400).json({ success: false, message: 'Template and client name are required.' });
    }

    const template = await ReportTemplate.findById(template_id);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });

    // Resolve the case<->client link so the report always reflects in Case
    // Management: if a case_id is given, derive the client from it; if only a
    // client_id is given, attach the client's active case when there is exactly one.
    let resolvedCaseId = case_id || null;
    let resolvedClientId = client_id || null;
    if (resolvedCaseId) {
      try {
        const caseData = await Case.findById(resolvedCaseId);
        if (caseData && !resolvedClientId) resolvedClientId = caseData.user_id;
      } catch (_) { /* non-fatal */ }
    } else if (resolvedClientId) {
      try {
        const activeCase = await db.query(
          `SELECT case_id FROM cases
           WHERE user_id = $1 AND status NOT IN ('Intake Rejected','Released','Closed')
           ORDER BY created_at DESC LIMIT 1`,
          [resolvedClientId]
        );
        if (activeCase.rows.length) resolvedCaseId = activeCase.rows[0].case_id;
      } catch (_) { /* non-fatal */ }
    }

    const report = await PsychologicalReport.create({
      template_id, psychologist_id: req.user.id,
      client_name, client_age, client_gender, date_of_assessment,
      case_id: resolvedCaseId,
      client_id: resolvedClientId,
    });

    // When a Psychologist authors a report they are the sole accountable party:
    // auto-populate Prepared By / Reviewed By / Approved By with their own name.
    if (req.user.role === 'psychologist') {
      await db.query(
        `UPDATE psychological_reports SET prepared_by = $1, reviewed_by = $1, approved_by = $1 WHERE id = $2`,
        [req.user.id, report.id]
      );
    }

    // Create sections from template
    const sections = template.sections_config || [];
    if (sections.length) {
      await PsychologicalReport.createSections(report.id, sections);
    }

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'created', details: `Report created using template: ${template.name}`, req });

    const fullReport = await PsychologicalReport.findById(report.id);
    const reportSections = await PsychologicalReport.getSections(report.id);

    // fullReport may be null if JOIN returns nothing — fall back to the raw INSERT row
    res.status(201).json({ success: true, report: fullReport || report, sections: reportSections });
  } catch (err) {
    console.error('Create report error:', err);
    res.status(500).json({ success: false, message: 'Failed to create report.' });
  }
};

// ── List Reports ───────────────────────────────────────────────
exports.listReports = async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    let reports;
    if (role === 'clinical_director') {
      reports = await PsychologicalReport.findAll(req.query);
    } else if (role === 'psychologist') {
      // Psychologist's active list: reports needing attention + reports they've approved.
      // revision_requested is excluded — that's with QCP for fixing.
      // 'Approved' is intentionally kept so the psychologist can see reports they approved.
      const INACTIVE_STATUSES = ['revision_requested', 'finalized', 'submitted', 'rejected'];
      const allOwn = await PsychologicalReport.findByPsychologist(userId);
      const ownReports = allOwn.filter(r => !INACTIVE_STATUSES.includes(r.status));
      const reviewQueue = await db.query(
        `SELECT pr.* FROM psychological_reports pr
         WHERE ((pr.status IN ('Review', 'Approved') AND pr.is_locked = FALSE)
                OR (pr.signature_stage IN ('psychologist', 'ready_for_release', 'released') AND pr.approved_by = $1))
           AND pr.deleted_at IS NULL AND pr.archived_at IS NULL`,
        [userId]
      );
      const seen = new Set(ownReports.map(r => r.id));
      reviewQueue.rows.filter(r => !seen.has(r.id)).forEach(r => ownReports.push(r));
      reports = ownReports;
    } else if (role === 'supervising_psychometrician') {
      // SupPsy sees: their own authored reports (except ones sent to QCP / Psychologist),
      // reports they prepared that are back for revision (revision_requested_qc).
      const allOwn = await PsychologicalReport.findByPsychologist(userId);
      // Hide own reports currently in QCP or Psychologist hands
      const ownReports = allOwn.filter(r => !['Prepared', 'Review', 'revision_requested'].includes(r.status));
      const revisionQueue = await db.query(
        `SELECT pr.* FROM psychological_reports pr
         WHERE (pr.status = 'revision_requested_qc'
                OR pr.signature_stage = 'supervising')
           AND pr.deleted_at IS NULL AND pr.archived_at IS NULL`,
        []
      );
      const seen = new Set(ownReports.map(r => r.id));
      revisionQueue.rows.filter(r => !seen.has(r.id)).forEach(r => ownReports.push(r));
      reports = ownReports;
    } else if (role === 'qc_psychometrician') {
      // QCP sees: Prepared reports (awaiting QC review) and revision_requested reports
      // (Psychologist sent back for QCP to fix). revision_requested_qc is NOT here —
      // that's with SupPsy now and should disappear from QCP's list.
      const ownReports = await PsychologicalReport.findByPsychologist(userId);
      const qcQueue = await db.query(
        `SELECT pr.* FROM psychological_reports pr
         WHERE ((pr.status IN ('Prepared', 'revision_requested') AND pr.is_locked = FALSE)
                OR pr.signature_stage = 'quality_control')
           AND pr.deleted_at IS NULL AND pr.archived_at IS NULL`,
        []
      );
      const seen = new Set(ownReports.map(r => r.id));
      qcQueue.rows.filter(r => !seen.has(r.id)).forEach(r => ownReports.push(r));
      reports = ownReports;
    } else {
      // Psychometrician and others see only their own authored reports
      reports = await PsychologicalReport.findByPsychologist(userId);
    }
    res.json({ success: true, reports });
  } catch (err) {
    console.error('List reports error:', err);
    res.status(500).json({ success: false, message: 'Failed to list reports.' });
  }
};

// ── Get Report Detail ──────────────────────────────────────────
exports.getReport = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    // Access control — psychologist can view reports they created, approved, or that are
    // currently in the Review/Approved stage (their approval queue).
    if (req.user.role === 'psychologist') {
      const isCreator  = String(report.psychologist_id) === String(req.user.id);
      const isApprover = String(report.approved_by)     === String(req.user.id);
      const inQueue    = report.status === 'Review' || report.status === 'Approved';
      let isCaseAssigned = false;
      if (!isCreator && !isApprover && !inQueue && report.case_id) {
        const caseData = await Case.findById(report.case_id);
        isCaseAssigned = caseData && String(caseData.assigned_psychologist_id) === String(req.user.id);
      }
      if (!isCreator && !isApprover && !inQueue && !isCaseAssigned) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    const sections = await PsychologicalReport.getSections(report.id);
    const assessmentData = await PsychologicalReport.getAssessmentData(report.id);
    const narratives = await PsychologicalReport.getNarratives(report.id);
    const approvals = await PsychologicalReport.getApprovals(report.id);

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'viewed', details: 'Report viewed', req });

    res.json({ success: true, report, sections, assessmentData, narratives, approvals });
  } catch (err) {
    console.error('Get report error:', err);
    res.status(500).json({ success: false, message: 'Failed to get report.' });
  }
};

// Returns true when the current user may edit the report.
// Revision chain: Psychologist → QCP → SupPsy
//   revision_requested     = Psychologist sent back to QCP for correction
//   revision_requested_qc  = QCP sent back to SupPsy for correction
function canEditReport(report, user) {
  const isCreator = report.psychologist_id === user.id;
  const isDirector = user.role === 'clinical_director';
  const isPsychologist = user.role === 'psychologist';
  const isSupPsy = user.role === 'supervising_psychometrician';
  const isQCP = user.role === 'qc_psychometrician';
  const isPreparer = report.prepared_by && String(report.prepared_by) === String(user.id);
  const isApprover = report.approved_by != null && String(report.approved_by) === String(user.id);

  // A released report under an active client concern may be corrected in place by
  // its approving psychologist (the author of record) or the CD — even though it
  // is finalized + locked. Client delivery uses the stored signed PDF, so these
  // edits stay private until the CD releases the corrected version.
  if (report.modification_status && (isApprover || isDirector)) return true;

  if (report.is_locked) return false;
  if (isDirector) return true;
  if (isCreator && ['draft', 'rejected', 'finalized', 'revision_requested_qc'].includes(report.status)) return true;
  if (isPreparer && ['draft', 'revision_requested_qc'].includes(report.status)) return true;
  if (isSupPsy && ['draft', 'revision_requested_qc'].includes(report.status)) return true;
  if (isQCP && ['Prepared', 'revision_requested'].includes(report.status)) return true;
  if (isPsychologist && report.status === 'Review') return true;
  return false;
}

// Returns the allowed edit statuses for error messages.
function editableStatuses(user, report) {
  const base = ['draft', 'rejected', 'finalized'];
  const isPsychologist = user.role === 'psychologist';
  const isQCP = user.role === 'qc_psychometrician';
  const isSupPsy = user.role === 'supervising_psychometrician' ||
    (report.prepared_by && String(report.prepared_by) === String(user.id));
  if (isPsychologist) return [...base, 'Review'];
  if (isQCP) return [...base, 'Prepared', 'revision_requested'];
  if (isSupPsy) return [...base, 'revision_requested_qc'];
  return base;
}

// ── Update Report (client info) ────────────────────────────────
exports.updateReport = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (!canEditReport(report, req.user)) {
      securityEvents.record({
        module: 'report_generation', eventType: 'unauthorized_editing',
        userId: req.user.id, subjectKind: req.user.type === 'staff' ? 'staff' : 'user', ip: req.ip,
        details: `Unauthorized edit attempt on report #${req.params.id} by role "${req.user.role}".`,
      });
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const allowed = editableStatuses(req.user, report);
    if (!allowed.includes(report.status)) {
      return res.status(400).json({ success: false, message: `This report cannot be edited in its current status (${report.status}).` });
    }

    const updated = await PsychologicalReport.updateClient(req.params.id, req.body);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: 'Client info updated', req });
    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('Update report error:', err);
    res.status(500).json({ success: false, message: 'Failed to update report.' });
  }
};

// ── Save Assessment Data ───────────────────────────────────────
exports.saveAssessmentData = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (!canEditReport(report, req.user)) return res.status(403).json({ success: false, message: 'Access denied.' });
    const allowed = editableStatuses(req.user, report);
    if (!allowed.includes(report.status)) {
      return res.status(400).json({ success: false, message: `This report cannot be edited in its current status (${report.status}).` });
    }

    // Server-side data integrity: reject invalid/nonsensical content before saving.
    const fieldCheck = RuleEngine.validateProvidedFields(req.body);
    if (!fieldCheck.valid) {
      return res.status(400).json({
        success: false,
        message: 'Assessment data failed validation.',
        errors: fieldCheck.errors,
      });
    }

    const data = await PsychologicalReport.upsertAssessmentData(req.params.id, req.body);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: 'Assessment data saved', req });
    res.json({ success: true, assessmentData: data });
  } catch (err) {
    console.error('Save assessment error:', err);
    res.status(500).json({ success: false, message: 'Failed to save assessment data.' });
  }
};

// ── Generate Narratives (Rule Engine) ──────────────────────────

// Map rule engine section keys to possible report section keys across template types
const SECTION_KEY_MAP = {
  'test_results':                       ['test_results', 'overall_result'],
  'findings':                           ['findings', 'summary', 'summary_formulation'],
  'recommendations':                    ['recommendations'],
  'behavioral_observation_mse':         ['behavioral_observation_mse'],
  'general_observations_interview_mse': ['general_observations_interview_mse'],
  'diagnostic_impression':              ['diagnostic_impression'],
  'overall_result':                     ['overall_result'],
  'impression_conclusion':              ['impression_conclusion'],
  'recommendation':                     ['recommendation'],
};

// ── Clinical "Assessment Tests/Methods" table validation (server side) ──
// The Clinical report stores this section as a [[TESTS_TABLE]] block. Mirrors the
// frontend rules so data integrity is enforced even if the UI is bypassed.
// Scope: applies ONLY to the clinical 'assessment_tests_methods' section — other
// report templates/sections are never affected.
function _parseTestsTableRows(content) {
  const m = String(content || '').match(/\[\[TESTS_TABLE\]\]([\s\S]*?)\[\[\/TESTS_TABLE\]\]/);
  if (!m) return null; // no table block present
  return m[1].split('\n').map(l => l.trim()).filter(Boolean).slice(1).map(line => {
    const parts = line.split('||');
    return { name: (parts[0] || '').trim(), date: (parts[1] || '').trim() };
  });
}

// Structural integrity of a non-empty table: no empty names, no duplicates.
// Empty content (no table block / no rows) is allowed mid-edit and returns [].
function validateTestsMethodsContent(content) {
  const errors = [];
  const rows = _parseTestsTableRows(content);
  if (!rows || rows.length === 0) return errors;
  const seen = new Set();
  let hasEmptyName = false;
  for (const r of rows) {
    if (!r.name) { hasEmptyName = true; continue; }
    const key = r.name.toLowerCase();
    if (seen.has(key)) errors.push('Duplicate assessment tests/methods are not allowed.');
    seen.add(key);
  }
  if (hasEmptyName) errors.unshift('Each assessment row must have a test/method name.');
  return [...new Set(errors)];
}

// Submission gate for clinical reports: requires ≥1 valid entry plus integrity.
async function validateClinicalTestsMethodsForSubmission(report) {
  if (!report || report.template_type !== 'clinical') return [];
  const sections = await PsychologicalReport.getSections(report.id);
  const section = sections.find(s => s.section_key === 'assessment_tests_methods');
  if (!section) return [];
  const rows = (_parseTestsTableRows(section.content) || []).filter(r => r.name);
  const errors = validateTestsMethodsContent(section.content);
  if (rows.length === 0) errors.unshift('At least one assessment test/method entry is required.');
  return [...new Set(errors)];
}

exports.generateNarratives = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (!canEditReport(report, req.user)) return res.status(403).json({ success: false, message: 'Access denied.' });
    const allowed = editableStatuses(req.user, report);
    if (!allowed.includes(report.status)) {
      return res.status(400).json({ success: false, message: `This report cannot be edited in its current status (${report.status}).` });
    }

    const assessmentData = await PsychologicalReport.getAssessmentData(report.id);

    // Validate the assessment data against the reference dataset bounds.
    const validation = RuleEngine.validateAssessment(assessmentData, report);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: 'Assessment data failed validation.',
        errors: validation.errors,
      });
    }

    // Rotate a per-report generation counter so each run differs from the last.
    const prevAdd = (assessmentData && assessmentData.additional_data) || {};
    const genIndex = (Number(prevAdd._gen_count) || 0) + 1;
    await PsychologicalReport.upsertAssessmentData(report.id, {
      tests_administered: (assessmentData && assessmentData.tests_administered) || [],
      observational_notes: (assessmentData && assessmentData.observational_notes) || '',
      behavioral_observations: (assessmentData && assessmentData.behavioral_observations) || '',
      interview_findings: (assessmentData && assessmentData.interview_findings) || '',
      additional_data: { ...prevAdd, _gen_count: genIndex },
    });

    // Generate the three sections (Test Results, Findings, Recommendations).
    const generated = RuleEngine.generate(assessmentData, report, genIndex);
    // Explainability trace (Item 4): which themes/signals/rules drove this run.
    // Attached non-enumerably to `generated`, so it never affects the section list.
    const trace = generated.trace || null;

    // Replace (not append) generated narratives so regeneration always overwrites.
    await PsychologicalReport.clearNarratives(report.id);
    for (const g of generated) {
      await PsychologicalReport.upsertNarrative(report.id, g.key, `${g.key}_gen${genIndex}`, g.content);
    }

    // Write the generated content into the matching report sections (overwrite).
    const existingSections = await PsychologicalReport.getSections(report.id);
    for (const g of generated) {
      const possibleKeys = SECTION_KEY_MAP[g.key] || [g.key];
      const section = existingSections.find(s => possibleKeys.includes(s.section_key));
      if (section) {
        await PsychologicalReport.updateSection(report.id, section.section_key, g.content);
        section.content = g.content;
      }
    }

    const savedNarratives = await PsychologicalReport.getNarratives(report.id);
    const updatedSections = await PsychologicalReport.getSections(report.id);

    const firedSummary = (trace && trace.firedRules && trace.firedRules.length)
      ? ` — rules: ${trace.firedRules.join(', ')}` : '';
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: `Generated narrative (run #${genIndex})${firedSummary}`, req });

    res.json({
      success: true,
      generated,                 // structured 3 sections for display
      narratives: savedNarratives,
      sections: updatedSections,
      generationIndex: genIndex,
      trace,                     // explainability: themes, signals, fired rule IDs
    });
  } catch (err) {
    console.error('Generate narratives error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate narratives.' });
  }
};

// ── Update Section Content ─────────────────────────────────────
exports.updateSection = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (!canEditReport(report, req.user)) return res.status(403).json({ success: false, message: 'Access denied.' });
    const allowed = editableStatuses(req.user, report);
    if (!allowed.includes(report.status)) {
      return res.status(400).json({ success: false, message: `This report cannot be edited in its current status (${report.status}).` });
    }

    const { content } = req.body;

    // Clinical Assessment Tests/Methods: reject duplicates / empty-named rows on
    // save so invalid table data can never be persisted (other sections untouched).
    if (req.params.sectionKey === 'assessment_tests_methods' && report.template_type === 'clinical') {
      const errors = validateTestsMethodsContent(content);
      if (errors.length) {
        return res.status(400).json({ success: false, message: 'Assessment Tests/Methods validation failed.', errors });
      }
    }

    const section = await PsychologicalReport.updateSection(req.params.id, req.params.sectionKey, content);
    if (!section) return res.status(404).json({ success: false, message: 'Section not found.' });

    // Create version snapshot
    const sections = await PsychologicalReport.getSections(report.id);
    const snapshot = { sections: sections.map(s => ({ key: s.section_key, content: s.content })) };
    await PsychologicalReport.createVersion(report.id, req.user.id, snapshot, [req.params.sectionKey], `Updated section: ${section.section_title}`);
    await PsychologicalReport.incrementVersion(report.id);

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: `Section updated: ${section.section_title}`, req });

    res.json({ success: true, section });
  } catch (err) {
    console.error('Update section error:', err);
    res.status(500).json({ success: false, message: 'Failed to update section.' });
  }
};

// ── Submit for Review ──────────────────────────────────────────
exports.submitReport = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.psychologist_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!['draft', 'rejected'].includes(report.status)) {
      return res.status(400).json({ success: false, message: 'Only draft or rejected reports can be submitted.' });
    }

    const updated = await PsychologicalReport.updateStatus(req.params.id, 'submitted');
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'submitted', details: 'Report submitted for review', req });

    // Notify the Clinical Director(s) that a report is awaiting their review.
    // The director may live in either the `users` or `staff` table, so notify
    // both. The author's name is resolved across both tables as well.
    try {
      const nameRow = await db.query(
        `SELECT COALESCE(u.full_name, NULLIF(TRIM(CONCAT_WS(' ', s.first_name, s.last_name)), '')) AS name
         FROM (SELECT $1::int AS id) x
         LEFT JOIN users u ON u.id = x.id
         LEFT JOIN staff s ON s.staff_id = x.id`,
        [req.user.id]
      );
      const author = nameRow.rows[0]?.name || 'A psychologist';
      const title = 'Report Submitted for Review';
      const message = `${author} submitted a report for ${report.client_name} for your review.`;
      await NotificationService.notifyRole('clinical_director', 'report', title, message, 'psych-reports.html');
      await NotificationService.notifyStaffRole('clinical_director', 'report', title, message, 'psych-reports.html');
    } catch (e) { console.warn('Submit notification failed:', e.message); }

    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('Submit report error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit report.' });
  }
};

// ── Approve Report (Clinical Director) ─────────────────────────
exports.approveReport = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.status !== 'submitted') {
      return res.status(400).json({ success: false, message: 'Only submitted reports can be approved.' });
    }

    await PsychologicalReport.createApproval(report.id, req.user.id, 'approved', req.body.comments || '');
    const updated = await PsychologicalReport.updateStatus(req.params.id, 'approved');
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'approved', details: req.body.comments || 'Report approved', req });

    // Notify the report author (staff) that the clinical director has reviewed it.
    try {
      const comment = (req.body.comments || '').trim();
      const nameRow = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
      const reviewer = nameRow.rows[0]?.full_name || 'The Clinical Director';
      await NotificationService.notifyUser(
        report.psychologist_id,
        'report',
        'Report Approved',
        `${reviewer} approved your report for ${report.client_name}.` + (comment ? ` Comment: "${comment}"` : ''),
        'psych-reports.html'
      );
    } catch (e) { console.warn('Approve notification failed:', e.message); }

    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('Approve report error:', err);
    res.status(500).json({ success: false, message: 'Failed to approve report.' });
  }
};

// ── Reject Report (Clinical Director) ──────────────────────────
exports.rejectReport = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.status !== 'submitted') {
      return res.status(400).json({ success: false, message: 'Only submitted reports can be rejected.' });
    }

    await PsychologicalReport.createApproval(report.id, req.user.id, 'rejected', req.body.comments || '');
    const updated = await PsychologicalReport.updateStatus(req.params.id, 'rejected');
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'rejected', details: req.body.comments || 'Report rejected', req });

    // Notify the report author (staff) that the clinical director has reviewed it.
    try {
      const comment = (req.body.comments || '').trim();
      const nameRow = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
      const reviewer = nameRow.rows[0]?.full_name || 'The Clinical Director';
      await NotificationService.notifyUser(
        report.psychologist_id,
        'report',
        'Report Rejected',
        `${reviewer} rejected your report for ${report.client_name}.` + (comment ? ` Comment: "${comment}"` : ' Please review and resubmit.'),
        'psych-reports.html'
      );
    } catch (e) { console.warn('Reject notification failed:', e.message); }

    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('Reject report error:', err);
    res.status(500).json({ success: false, message: 'Failed to reject report.' });
  }
};

// ── Finalize Report ────────────────────────────────────────────
exports.finalizeReport = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Only approved reports can be finalized.' });
    }

    const updated = await PsychologicalReport.updateStatus(req.params.id, 'finalized');
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'finalized', details: 'Report finalized', req });
    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('Finalize report error:', err);
    res.status(500).json({ success: false, message: 'Failed to finalize report.' });
  }
};

// ── Generate PDF ───────────────────────────────────────────────
exports.generatePdf = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    if (req.user.role === 'psychologist') {
      const isCreator  = String(report.psychologist_id) === String(req.user.id);
      const isApprover = String(report.approved_by)     === String(req.user.id);
      const inQueue    = report.status === 'Review' || report.status === 'Approved';
      if (!isCreator && !isApprover && !inQueue) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    // Once signing has begun, the authoritative PDF is the latest SAVED signed
    // version — never regenerated from report data (which would drop signatures).
    // EXCEPTION: while a report is under client-concern modification, the
    // psychologist is correcting its sections, so the preview/snapshot must
    // reflect the LIVE edited content — regenerate from report data instead.
    const latestSigned = report.modification_status ? null : await ReportSignedPdf.getLatest(report.id);
    if (latestSigned && latestSigned.pdf_base64) {
      const raw = String(latestSigned.pdf_base64).replace(/^data:application\/pdf;base64,/, '');
      const signedBuffer = Buffer.from(raw, 'base64');
      await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'downloaded', details: `Saved signed PDF v${latestSigned.version_number} served`, req });
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="PsychReport_${report.client_name.replace(/\s+/g, '_')}_${report.id}.pdf"`,
        'Content-Length': signedBuffer.length,
      });
      return res.send(signedBuffer);
    }

    const sections = await PsychologicalReport.getSections(report.id);
    const assessmentData = await PsychologicalReport.getAssessmentData(report.id);
    const approvals = await PsychologicalReport.getApprovals(report.id);

    const certOptions = {
      includeCertificate:   req.query.include_certificate === '1',
      certAddress:          req.query.cert_address          || '',
      certPurpose:          req.query.cert_purpose          || '',
      certImpression:       req.query.cert_impression       || '',
      certValidity:         req.query.cert_validity         || '',
      certLicenseNo:        req.query.cert_license_no       || '',
      certPtrNo:            req.query.cert_ptr_no           || '',
      certLicenseValidity:  req.query.cert_license_validity || '',
    };
    const pdfBuffer = await PdfGenerator.generate(report, sections, assessmentData, approvals, certOptions);

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'downloaded', details: 'PDF generated and downloaded', req });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="PsychReport_${report.client_name.replace(/\s+/g, '_')}_${report.id}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Generate PDF error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate PDF.' });
  }
};

// ── Version History ────────────────────────────────────────────
exports.getVersions = async (req, res) => {
  try {
    const versions = await PsychologicalReport.getVersions(req.params.id);
    res.json({ success: true, versions });
  } catch (err) {
    console.error('Get versions error:', err);
    res.status(500).json({ success: false, message: 'Failed to get versions.' });
  }
};

// ── Restore Version ────────────────────────────────────────────
exports.restoreVersion = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    const version = await PsychologicalReport.getVersion(req.params.versionId);
    if (!version) return res.status(404).json({ success: false, message: 'Version not found.' });

    // Restore sections from snapshot
    const snapshot = version.sections_snapshot;
    if (snapshot && snapshot.sections) {
      for (const s of snapshot.sections) {
        await PsychologicalReport.updateSection(report.id, s.key, s.content);
      }
    }

    await PsychologicalReport.incrementVersion(report.id);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'version_restored', details: `Restored to version ${version.version_number}`, req });
    res.json({ success: true, message: `Restored to version ${version.version_number}` });
  } catch (err) {
    console.error('Restore version error:', err);
    res.status(500).json({ success: false, message: 'Failed to restore version.' });
  }
};

// ── Delete Report (soft delete → Trash) ────────────────────────
// Only the Clinical Director or the report's creator (psychologist) may delete.
// The report is moved to Trash (deleted_at stamped) rather than removed, so it
// can be restored later. Related rows are retained.
exports.deleteReport = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    // Quality Control Psychometricians may NEVER delete reports (review/sign role only).
    if (req.user.role === 'qc_psychometrician') {
      return res.status(403).json({ success: false, message: 'Quality Control Psychometricians cannot delete reports.' });
    }
    const isOwner = report.psychologist_id === req.user.id;
    const isDirector = req.user.role === 'clinical_director';
    // Supervising Psychometrician / Psychologist lose the delete option once the
    // report is Approved or in any Signature Required stage. Only the Clinical
    // Director can delete from that point on.
    if (!isDirector && (report.status === 'Approved' || report.signature_stage)) {
      return res.status(403).json({ success: false, message: 'This report can no longer be deleted once it is approved or in the signature stage.' });
    }
    if (!isOwner && !isDirector) {
      return res.status(403).json({ success: false, message: 'Only the clinical director or the report creator can delete this report.' });
    }

    await PsychologicalReport.softDelete(req.params.id);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'deleted', details: `Report moved to Trash for client: ${report.client_name}`, req });

    res.json({ success: true, message: 'Report moved to Trash.' });
  } catch (err) {
    console.error('Delete report error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete report.' });
  }
};

// ── Bulk Delete (soft delete) ──────────────────────────────────
exports.bulkDeleteReports = async (req, res) => {
  try {
    const ids = (req.body.ids || []).map(Number).filter((n) => Number.isInteger(n));
    if (!ids.length) return res.status(400).json({ success: false, message: 'No reports selected.' });

    // Quality Control Psychometricians may NEVER delete reports.
    if (req.user.role === 'qc_psychometrician') {
      return res.status(403).json({ success: false, message: 'Quality Control Psychometricians cannot delete reports.' });
    }
    // Psychologists may only delete their own reports; directors may delete any.
    const restrict = req.user.role === 'clinical_director' ? null : req.user.id;
    const affected = await PsychologicalReport.softDeleteMany(ids, restrict);

    await ReportAudit.log({ reportId: null, userId: req.user.id, action: 'deleted', details: `Bulk moved ${affected.length} report(s) to Trash`, req });
    res.json({ success: true, affected, message: `${affected.length} report(s) moved to Trash.` });
  } catch (err) {
    console.error('Bulk delete error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete selected reports.' });
  }
};

// ── Bulk Mark Read / Unread ────────────────────────────────────
exports.bulkSetReadStatus = async (req, res) => {
  try {
    const ids = (req.body.ids || []).map(Number).filter((n) => Number.isInteger(n));
    const isRead = !!req.body.is_read;
    if (!ids.length) return res.status(400).json({ success: false, message: 'No reports selected.' });

    const restrict = req.user.role === 'clinical_director' ? null : req.user.id;
    const affected = await PsychologicalReport.setReadStatus(ids, isRead, restrict);

    res.json({ success: true, affected, is_read: isRead, message: `${affected.length} report(s) marked as ${isRead ? 'read' : 'unread'}.` });
  } catch (err) {
    console.error('Bulk read-status error:', err);
    res.status(500).json({ success: false, message: 'Failed to update selected reports.' });
  }
};

// ── Bulk Archive ───────────────────────────────────────────────
exports.bulkArchiveReports = async (req, res) => {
  try {
    const ids = (req.body.ids || []).map(Number).filter((n) => Number.isInteger(n));
    if (!ids.length) return res.status(400).json({ success: false, message: 'No reports selected.' });

    const restrict = req.user.role === 'clinical_director' ? null : req.user.id;
    const affected = await PsychologicalReport.archiveMany(ids, restrict);

    await ReportAudit.log({ reportId: null, userId: req.user.id, action: 'archived', details: `Bulk archived ${affected.length} report(s)`, req });
    res.json({ success: true, affected, message: `${affected.length} report(s) archived.` });
  } catch (err) {
    console.error('Bulk archive error:', err);
    res.status(500).json({ success: false, message: 'Failed to archive selected reports.' });
  }
};

// ── Archive (view) ─────────────────────────────────────────────
exports.getArchive = async (req, res) => {
  try {
    const restrict = req.user.role === 'clinical_director' ? null : req.user.id;
    const reports = await PsychologicalReport.findArchived(restrict);
    res.json({ success: true, reports });
  } catch (err) {
    console.error('Get archive error:', err);
    res.status(500).json({ success: false, message: 'Failed to load Archive.' });
  }
};

// ── Restore from Archive (unarchive) ───────────────────────────
exports.unarchiveReport = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    const isOwner = report.psychologist_id === req.user.id;
    const isDirector = req.user.role === 'clinical_director';
    if (!isOwner && !isDirector) {
      return res.status(403).json({ success: false, message: 'You can only restore your own archived reports.' });
    }
    if (!report.archived_at) return res.status(400).json({ success: false, message: 'Report is not archived.' });

    const restrict = isDirector ? null : req.user.id;
    const restored = await PsychologicalReport.unarchive(req.params.id, restrict);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'unarchived', details: `Report restored from Archive for client: ${report.client_name}`, req });
    res.json({ success: true, report: restored, message: 'Report restored from Archive.' });
  } catch (err) {
    console.error('Unarchive report error:', err);
    res.status(500).json({ success: false, message: 'Failed to restore report from Archive.' });
  }
};

// ── Trash (Clinical Director) ──────────────────────────────────
exports.getTrash = async (req, res) => {
  try {
    const reports = await PsychologicalReport.findTrash();
    res.json({ success: true, reports });
  } catch (err) {
    console.error('Get trash error:', err);
    res.status(500).json({ success: false, message: 'Failed to load Trash.' });
  }
};

// ── Restore from Trash (Clinical Director) ─────────────────────
exports.restoreReport = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (!report.deleted_at) return res.status(400).json({ success: false, message: 'Report is not in Trash.' });

    const restored = await PsychologicalReport.restore(req.params.id);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'restored', details: `Report restored from Trash for client: ${report.client_name}`, req });
    res.json({ success: true, report: restored, message: 'Report restored.' });
  } catch (err) {
    console.error('Restore report error:', err);
    res.status(500).json({ success: false, message: 'Failed to restore report.' });
  }
};

// ── Permanent Delete from Trash (Clinical Director) ────────────
exports.permanentlyDeleteReport = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'deleted', details: `Report permanently deleted for client: ${report.client_name}`, req });
    await PsychologicalReport.hardDelete(req.params.id);
    res.json({ success: true, message: 'Report permanently deleted.' });
  } catch (err) {
    console.error('Permanent delete error:', err);
    res.status(500).json({ success: false, message: 'Failed to permanently delete report.' });
  }
};

// ── Audit Logs ─────────────────────────────────────────────────
exports.getAuditLogs = async (req, res) => {
  try {
    const logs = await ReportAudit.getLogs(req.query);
    res.json({ success: true, logs });
  } catch (err) {
    console.error('Get audit logs error:', err);
    res.status(500).json({ success: false, message: 'Failed to get audit logs.' });
  }
};

// ── Pending Reviews ────────────────────────────────────────────
exports.getPendingReviews = async (req, res) => {
  try {
    const reports = await PsychologicalReport.findPendingReview();
    res.json({ success: true, reports });
  } catch (err) {
    console.error('Get pending reviews error:', err);
    res.status(500).json({ success: false, message: 'Failed to get pending reviews.' });
  }
};

// ── Get Clients with Completed Intake Forms ────────────────────
exports.getIntakeClients = async (req, res) => {
  try {
    const role = req.user && req.user.role;

    // Supervising psychometricians handle assessments only — exclude counseling clients.
    // Psychologists handle counseling only — exclude assessment clients.
    // All other staff (qc_psychometrician, clinical_director) see both.
    const includeAssessment = true;
    const includeCounseling = role !== 'supervising_psychometrician' && role !== 'psychometrician';

    const parts = [];

    if (includeAssessment) {
      parts.push(`
        SELECT
          aif.id          AS intake_id,
          aif.user_id,
          CONCAT(aif.given_name, ' ', aif.family_name) AS full_name,
          aif.age,
          aif.sex         AS gender,
          aif.birthdate   AS date_of_birth,
          aif.email,
          aif.home_address AS address,
          aif.created_at,
          u.full_name     AS account_name,
          u.email         AS account_email,
          c.case_id,
          'assessment'    AS form_type
        FROM assessment_intake_forms aif
        JOIN appointments a ON a.assessment_form_id = aif.id AND a.payment_status = 'paid_verified'
        JOIN users u ON u.id = aif.user_id
        LEFT JOIN cases c ON c.case_id = aif.case_id`);
    }

    if (includeCounseling) {
      parts.push(`
        SELECT
          i.id            AS intake_id,
          i.user_id,
          i.full_name,
          i.age,
          i.gender,
          i.date_of_birth,
          i.email,
          i.address,
          i.created_at,
          u.full_name     AS account_name,
          u.email         AS account_email,
          c.case_id,
          'counseling'    AS form_type
        FROM intake_forms i
        JOIN appointments a ON a.intake_form_id = i.id AND a.payment_status = 'paid_verified'
        JOIN users u ON u.id = i.user_id
        LEFT JOIN cases c ON c.case_id = i.case_id`);
    }

    if (!parts.length) {
      return res.json({ success: true, clients: [] });
    }

    const sql = `
      SELECT intake_id, user_id, full_name, age, gender, date_of_birth,
             email, address, created_at, account_name, account_email,
             case_id, form_type
      FROM (${parts.join(' UNION ')}) combined
      ORDER BY created_at DESC
    `;

    const result = await db.query(sql);
    res.json({ success: true, clients: result.rows });
  } catch (err) {
    console.error('Get intake clients error:', err);
    res.status(500).json({ success: false, message: 'Failed to get intake clients.' });
  }
};

// ── E-Signature (DocuSeal) ──────────────────────────────────────
exports.requestEsign = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    const { signature_image } = req.body;

    // Generate PDF
    const sections = await PsychologicalReport.getSections(report.id);
    const assessmentData = await PsychologicalReport.getAssessmentData(report.id);
    const approvals = await PsychologicalReport.getApprovals(report.id);
    const pdfBuffer = await PdfGenerator.generate(report, sections, assessmentData, approvals, { includeCertificate: false });

    // If DocuSeal is configured, send to DocuSeal for e-signature
    const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY || '';
    if (DOCUSEAL_API_KEY) {
      const signerEmail = req.user.email || req.body.email;
      const signerName = req.user.full_name || req.body.name || 'Signer';
      const reportTitle = `PsychReport_${(report.client_name || 'Report').replace(/\s+/g, '_')}_${report.id}`;

      const submission = await DocuSealService.createSubmissionBase64(
        pdfBuffer, signerEmail, signerName, reportTitle
      );

      // Extract signing URL from the response
      let signingUrl = '';
      if (Array.isArray(submission)) {
        const submitter = submission[0];
        signingUrl = submitter?.embed_src || `https://docuseal.com/s/${submitter?.slug}` || '';
      } else if (submission.submitters) {
        const submitter = submission.submitters[0];
        signingUrl = submitter?.embed_src || `https://docuseal.com/s/${submitter?.slug}` || '';
      } else if (submission.slug) {
        signingUrl = `https://docuseal.com/s/${submission.slug}`;
      }

      await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: 'E-signature requested via DocuSeal', req });

      return res.json({
        success: true,
        signing_url: signingUrl,
        submission: Array.isArray(submission) ? submission[0] : submission,
      });
    }

    // No DocuSeal configured — signature was captured locally
    if (signature_image) {
      await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: 'E-signature captured locally (draw/upload)', req });

      return res.json({
        success: true,
        message: 'Signature captured successfully.',
        signature_applied: true,
      });
    }

    // No DocuSeal and no signature image
    return res.status(400).json({ success: false, message: 'DocuSeal API key not configured and no signature image provided.' });
  } catch (err) {
    console.error('E-signature request error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to create e-signature request.' });
  }
};

exports.getEsignStatus = async (req, res) => {
  try {
    const data = await DocuSealService.getSubmission(req.params.submissionId);
    res.json({ success: true, submission: data });
  } catch (err) {
    console.error('E-sign status error:', err);
    res.status(500).json({ success: false, message: 'Failed to check e-signature status.' });
  }
};

// ── E-Signature Form Builder (place/drag/resize signature) ──────
// Step 1: generate the PDF, create a DocuSeal template from it, and return a
// builder JWT. The frontend opens <docuseal-builder> with this token so the
// psychologist can position and resize the signature field on the document.
exports.getEsignBuilder = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    if (req.user.role === 'psychologist' && report.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const sections = await PsychologicalReport.getSections(report.id);
    const assessmentData = await PsychologicalReport.getAssessmentData(report.id);
    const approvals = await PsychologicalReport.getApprovals(report.id);
    const pdfBuffer = await PdfGenerator.generate(report, sections, assessmentData, approvals, { includeCertificate: false });

    const reportTitle = `PsychReport_${(report.client_name || 'Report').replace(/\s+/g, '_')}_${report.id}`;
    const template = await DocuSealService.createTemplateFromPdf(pdfBuffer, reportTitle);
    const templateId = Array.isArray(template) ? template[0]?.id : template.id;

    const builderToken = DocuSealService.buildBuilderToken({
      templateId,
      integrationEmail: req.user.email,
    });

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: 'E-signature builder opened (DocuSeal)', req });

    res.json({ success: true, builder_token: builderToken, template_id: templateId });
  } catch (err) {
    console.error('E-sign builder error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to open signature builder.' });
  }
};

// ── 3-Stage Workflow ───────────────────────────────────────────

// SupPsy submits report as Prepared → QCP queue
// Case: Assessment Completed → Report Drafting
exports.workflowPrepare = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.is_locked) return res.status(400).json({ success: false, message: 'Report is locked.' });

    // Clinical report: block submission unless the Assessment Tests/Methods table
    // has at least one valid, non-duplicate entry.
    const ctmErrors = await validateClinicalTestsMethodsForSubmission(report);
    if (ctmErrors.length) {
      return res.status(400).json({ success: false, message: 'Assessment Tests/Methods validation failed.', errors: ctmErrors });
    }

    const updated = await PsychologicalReport.submitPrepared(report.id, req.user.id);
    if (!updated) return res.status(400).json({ success: false, message: 'Could not mark as Prepared. Report may already be further in the workflow.' });

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'prepared', details: 'Report marked as Prepared — sent to QC queue', req });

    if (report.case_id) {
      try { await Case.updateStatus(report.case_id, 'Report Drafting', { staffId: req.user.id, ipAddress: req.ip }); }
      catch (e) { console.warn('workflowPrepare case update skipped:', e.message); }
    }

    try {
      await NotificationService.notifyStaffRole('qc_psychometrician', 'report', 'Report Ready for QC Review',
        `A report for ${report.client_name} is ready for your QC review.`, `psych-reports.html?reportId=${report.id}`);
      // Confirm to the Supervising Psychometrician (submitter) that their report was submitted and is being reviewed.
      await NotificationService.notifyUser(req.user.id, 'report', 'Report Submitted to Quality Control',
        `Your report for ${report.client_name} has been submitted to the Quality Control Psychometrician and is being reviewed.`,
        `psych-reports.html?reportId=${report.id}`);
    } catch (e) { console.warn('workflowPrepare notification failed:', e.message); }

    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('workflowPrepare error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit report for QC.' });
  }
};

// QCP completes review → Psychologist queue
// Case: Report Drafting → Awaiting Director Approval
exports.workflowReview = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.is_locked) return res.status(400).json({ success: false, message: 'Report is locked.' });

    const updated = await PsychologicalReport.submitToReview(report.id, req.user.id);
    if (!updated) return res.status(400).json({ success: false, message: 'Report must be in Prepared status to submit for psychologist review.' });

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'reviewed', details: 'QC review completed — sent to psychologist', req });

    if (report.case_id) {
      try { await Case.updateStatus(report.case_id, 'Awaiting Director Approval', { staffId: req.user.id, ipAddress: req.ip }); }
      catch (e) { console.warn('workflowReview case update skipped:', e.message); }
    }

    try {
      await NotificationService.notifyStaffRole('psychologist', 'report', 'Report Ready for Psychologist Approval',
        `QC review is complete for ${report.client_name}'s report. Please review and approve.`, `psych-reports.html?reportId=${report.id}`);
      // Inform the Supervising Psychometrician (original preparer) that their report
      // has been reviewed and validated — this is a READ-ONLY notice (null link, no action button).
      if (report.prepared_by) {
        await NotificationService.notifyUser(report.prepared_by, 'report', 'Report Reviewed & Validated',
          `Your report for ${report.client_name} has been reviewed and validated by the Quality Control Psychometrician.`,
          null);
      }
      // Confirm to the QC Psychometrician (submitter) that their report was submitted to the Psychologist.
      await NotificationService.notifyUser(req.user.id, 'report', 'Report Submitted to Psychologist',
        `Your report for ${report.client_name} has been submitted to the Psychologist and is being reviewed.`,
        `psych-reports.html?reportId=${report.id}`);
    } catch (e) { console.warn('workflowReview notification failed:', e.message); }

    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('workflowReview error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit report for psychologist review.' });
  }
};

// Psychologist approves final report
// Case: Awaiting Director Approval → Report Approved
exports.workflowApprove = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.is_locked) return res.status(400).json({ success: false, message: 'Report is locked.' });

    const updated = await PsychologicalReport.approveWorkflow(report.id, req.user.id);
    if (!updated) return res.status(400).json({ success: false, message: 'Report must be in Review status to approve.' });

    // Enter the signature pipeline: the Supervising Psychometrician must sign first.
    await db.query(`UPDATE psychological_reports SET signature_stage = 'supervising', updated_at = NOW() WHERE id = $1`, [report.id]);

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'approved', details: req.body.comments || 'Report approved by psychologist', req });

    if (report.case_id) {
      try { await Case.updateStatus(report.case_id, 'Report Approved', { staffId: req.user.id, ipAddress: req.ip }); }
      catch (e) { console.warn('workflowApprove case update skipped:', e.message); }
    }

    // Signature workflow: notify the Supervising Psychometrician a signature is required.
    try {
      await NotificationService.notifyStaffRole('supervising_psychometrician', 'report', 'Report Approved — Signature Required',
        `The report for ${report.client_name} has been approved and requires your signature. Open it in Psych Reports to sign.`,
        `psych-reports.html?reportId=${report.id}`);
    } catch (e) { console.warn('workflowApprove notification failed:', e.message); }

    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('workflowApprove error:', err);
    res.status(500).json({ success: false, message: 'Failed to approve report.' });
  }
};

// ── Psychologist SOLO flow ──────────────────────────────────────
// A Psychologist authors a report end-to-end. After saving it as a draft they
// can re-open it to Edit / Delete / Approve. Approving their OWN draft skips the
// Supervising/QC pipeline: the psychologist is recorded as Prepared/Reviewed/
// Approved By, and the report enters the signature pipeline directly at the
// 'psychologist' stage (Sign → Save Signed PDF → Submit to Clinical Director).
exports.psychologistApprove = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.is_locked) return res.status(400).json({ success: false, message: 'Report is locked.' });
    if (String(report.psychologist_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'You can only approve your own report.' });
    }
    if (!['draft', 'rejected'].includes(report.status)) {
      return res.status(400).json({ success: false, message: 'Only a draft report can be approved.' });
    }

    // Clinical report: block approval unless the Assessment Tests/Methods table
    // has at least one valid, non-duplicate entry.
    const ctmErrors = await validateClinicalTestsMethodsForSubmission(report);
    if (ctmErrors.length) {
      return res.status(400).json({ success: false, message: 'Assessment Tests/Methods validation failed.', errors: ctmErrors });
    }

    await db.query(
      `UPDATE psychological_reports
         SET status = 'Approved', prepared_by = $1, reviewed_by = $1, approved_by = $1,
             signature_stage = 'psychologist', updated_at = NOW()
       WHERE id = $2`,
      [req.user.id, report.id]
    );
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'approved', details: 'Report approved by Psychologist (solo flow) — ready to sign', req });

    if (report.case_id) {
      try { await Case.updateStatus(report.case_id, 'Report Approved', { staffId: req.user.id, ipAddress: req.ip }); }
      catch (e) { console.warn('psychologistApprove case update skipped:', e.message); }
    }

    res.json({ success: true, message: 'Report approved. You can now sign and submit it to the Clinical Director.' });
  } catch (err) {
    console.error('psychologistApprove error:', err);
    res.status(500).json({ success: false, message: 'Failed to approve report.' });
  }
};

// Psychologist requests revision — status → 'revision_requested', original submitter (SupPsy) is notified
// Case: Awaiting Director Approval → Report Drafting
exports.workflowRevise = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.is_locked) return res.status(400).json({ success: false, message: 'Report is locked.' });
    if (report.status !== 'Review') return res.status(400).json({ success: false, message: 'Only reports in Review status can be sent back for revision.' });

    const comment = (req.body.comments || '').trim();
    const updated = await PsychologicalReport.requestRevision(report.id, req.user.id, comment || null);
    if (!updated) return res.status(400).json({ success: false, message: 'Could not request revision. Report status may have changed.' });

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'revision_requested', details: comment || 'Revision requested by psychologist', req });

    if (report.case_id) {
      try { await Case.updateStatus(report.case_id, 'Report Drafting', { staffId: req.user.id, ipAddress: req.ip }); }
      catch (e) { console.warn('workflowRevise case update skipped:', e.message); }
    }

    // Notify QCP — they are responsible for fixing the report and resubmitting to the Psychologist
    try {
      const msg = `The psychologist has requested revisions on the report for ${report.client_name}.` + (comment ? ` Notes: "${comment}"` : '') +
        ' Please edit the report and submit it back to the Psychologist for approval.';
      await NotificationService.notifyStaffRole('qc_psychometrician', 'report', 'Report Revision Requested by Psychologist', msg, `psych-reports.html?reportId=${report.id}`);
    } catch (e) { console.warn('workflowRevise notification failed:', e.message); }

    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('workflowRevise error:', err);
    res.status(500).json({ success: false, message: 'Failed to request revision.' });
  }
};

// QC Psychometrician requests revision — status → 'revision_requested_qc'
// Sends report back to SupPsy for correction before returning to QC queue.
exports.workflowQcRevise = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.is_locked) return res.status(400).json({ success: false, message: 'Report is locked.' });
    if (report.status !== 'Prepared') {
      return res.status(400).json({ success: false, message: 'Only reports in Prepared status can be returned for QC revision.' });
    }

    const comment = (req.body.comments || '').trim();
    const updated = await PsychologicalReport.requestQcRevision(report.id, req.user.id, comment || null);
    if (!updated) return res.status(400).json({ success: false, message: 'Could not request QC revision. Report status may have changed.' });

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'qc_revision_requested', details: comment || 'Revision requested by QC Psychometrician', req });

    if (report.case_id) {
      try { await Case.updateStatus(report.case_id, 'Report Drafting', { staffId: req.user.id, ipAddress: req.ip }); }
      catch (e) { console.warn('workflowQcRevise case update skipped:', e.message); }
    }

    // Notify the original submitter (SupPsy who prepared the report)
    try {
      const notifyId = report.prepared_by;
      const msg = `The Quality Control Psychometrician has requested revisions on the report for ${report.client_name}.` + (comment ? ` Notes: "${comment}"` : '') +
        ' Please edit and resubmit the report for QC review.';
      if (notifyId) {
        await NotificationService.notifyUser(notifyId, 'report', 'Report Revision Requested by QC', msg, `psych-reports.html?reportId=${report.id}`);
      } else {
        await NotificationService.notifyStaffRole('supervising_psychometrician', 'report', 'Report Revision Requested by QC', msg, `psych-reports.html?reportId=${report.id}`);
      }
    } catch (e) { console.warn('workflowQcRevise notification failed:', e.message); }

    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('workflowQcRevise error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to request QC revision.' });
  }
};

// SupPsy resubmits report after revision was requested.
// If status is 'revision_requested' → goes back to 'Review' (directly to psychologist).
// If status is 'revision_requested_qc' → goes back to 'Prepared' (QC queue).
exports.workflowResubmit = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.is_locked) return res.status(400).json({ success: false, message: 'Report is locked.' });

    if (!['revision_requested', 'revision_requested_qc'].includes(report.status)) {
      return res.status(400).json({
        success: false,
        message: 'Only reports with a revision request can be resubmitted.',
      });
    }

    let updated;
    let notifyRole;
    let notifyMsg;

    if (report.status === 'revision_requested') {
      updated = await PsychologicalReport.resubmitToReview(report.id, req.user.id);
      if (!updated) return res.status(400).json({ success: false, message: 'Could not resubmit report. Please try again.' });
      notifyRole = 'psychologist';
      // Include the specific QCP name who revised the report
      try {
        const revisorRow = await db.query('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
        const revisorName = revisorRow.rows[0]?.full_name || 'The Quality Control Psychometrician';
        notifyMsg = `The revised report for ${report.client_name} has been resubmitted by ${revisorName}. Please review and approve.`;
      } catch (_) {
        notifyMsg = `The revised report for ${report.client_name} has been resubmitted by the QC Psychometrician for your approval.`;
      }
      await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'resubmitted', details: 'QCP resubmitted revised report to psychologist for review', req });
    } else {
      updated = await PsychologicalReport.resubmitToQc(report.id, req.user.id);
      if (!updated) return res.status(400).json({ success: false, message: 'Could not resubmit report. Please try again.' });
      notifyRole = 'qc_psychometrician';
      notifyMsg = `The revised report for ${report.client_name} has been resubmitted for QC review.`;
      await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'resubmitted', details: 'Revised report resubmitted to QC for review', req });
    }

    if (report.case_id) {
      const targetStatus = report.status === 'revision_requested' ? 'Awaiting Director Approval' : 'Report Drafting';
      try { await Case.updateStatus(report.case_id, targetStatus, { staffId: req.user.id, ipAddress: req.ip }); }
      catch (e) { console.warn('workflowResubmit case update skipped:', e.message); }
    }

    try {
      await NotificationService.notifyStaffRole(notifyRole, 'report', 'Revised Report Resubmitted', notifyMsg, `psych-reports.html?reportId=${report.id}`);
    } catch (e) { console.warn('workflowResubmit notification failed:', e.message); }

    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('workflowResubmit error:', err);
    res.status(500).json({ success: false, message: 'Failed to resubmit report.' });
  }
};

// CD locks or unlocks a report to prevent/allow further edits
exports.workflowLock = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    const lock = req.body.lock !== false; // default to locking
    const updated = await PsychologicalReport.setLocked(report.id, lock);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: lock ? 'locked' : 'unlocked', details: lock ? 'Report locked by Clinical Director' : 'Report unlocked by Clinical Director', req });

    res.json({ success: true, report: updated, locked: lock });
  } catch (err) {
    console.error('workflowLock error:', err);
    res.status(500).json({ success: false, message: 'Failed to update lock status.' });
  }
};

// ═══════════════════════════════════════════════════════════════
// SIGNATURE & RELEASE WORKFLOW
// (Psychologist approves) → Supervising signs → QC signs →
//  Ready For Release → Psychologist releases → Released to client
// ═══════════════════════════════════════════════════════════════

// POST /api/reports/:id/save-signed-pdf
// Persist the currently-signed PDF as a NEW immutable version so signatures
// survive refresh, navigation, stage changes, and release. Never overwrites.
exports.saveSignedPdf = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    const { pdf, signature_stage } = req.body;
    if (!pdf || typeof pdf !== 'string') {
      return res.status(400).json({ success: false, message: 'A signed PDF file is required.' });
    }
    // Released reports are immutable.
    if (report.signature_stage === 'released') {
      return res.status(409).json({ success: false, message: 'This report has been released and can no longer be modified.' });
    }

    const VALID_STAGES = ['supervising', 'quality_control', 'psychologist'];
    const stage = VALID_STAGES.includes(signature_stage) ? signature_stage : 'supervising';
    const saved = await ReportSignedPdf.save(report.id, { pdfBase64: pdf, signatureStage: stage, signedBy: req.user.id });

    // Track who signed at each stage (kept even though version history is hidden in UI).
    if (stage === 'supervising') {
      await db.query(`UPDATE psychological_reports SET supervising_signed_by = $1, supervising_signed_at = NOW(), updated_at = NOW() WHERE id = $2`, [req.user.id, report.id]);
    } else if (stage === 'quality_control') {
      await db.query(`UPDATE psychological_reports SET qc_signed_by = $1, qc_signed_at = NOW(), updated_at = NOW() WHERE id = $2`, [req.user.id, report.id]);
    }
    // psychologist-stage signature is captured in report_signed_pdfs (no report-level column needed).

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'signed_pdf_saved', details: `Signed PDF saved (stage: ${stage}, v${saved.version_number})`, req });

    res.json({ success: true, message: 'Signed PDF saved.', version: saved });
  } catch (err) {
    console.error('saveSignedPdf error:', err);
    res.status(500).json({ success: false, message: 'Failed to save signed PDF.' });
  }
};

// POST /api/reports/:id/submit-to-qc
// Supervising Psychometrician hands off to QC. Requires a saved signed PDF.
exports.submitToQc = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.signature_stage !== 'supervising') {
      return res.status(400).json({ success: false, message: 'Report is not awaiting the Supervising Psychometrician signature.' });
    }

    const hasSigned = await ReportSignedPdf.exists(report.id);
    if (!hasSigned) {
      return res.status(400).json({ success: false, message: 'Please save your signed PDF before submitting to Quality Control.' });
    }

    await db.query(`UPDATE psychological_reports SET signature_stage = 'quality_control', updated_at = NOW() WHERE id = $1`, [report.id]);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'submitted_to_qc', details: 'Supervising signature locked; submitted to QC', req });

    try {
      await NotificationService.notifyStaffRole('qc_psychometrician', 'report', 'Report Approved — Signature Required',
        `The report for ${report.client_name} requires your Quality Control signature. Open it in Psych Reports to sign.`,
        `psych-reports.html?reportId=${report.id}`);
    } catch (e) { console.warn('submitToQc notification failed:', e.message); }

    res.json({ success: true, message: 'Submitted to Quality Control Psychometrician.' });
  } catch (err) {
    console.error('submitToQc error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit to QC.' });
  }
};

// POST /api/reports/:id/mark-signed
// QC finalizes their signature and hands off to the Psychologist for signing.
// (Button label: "Submit to Psychologist".) Requires a saved signed PDF.
exports.markSigned = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.signature_stage !== 'quality_control') {
      return res.status(400).json({ success: false, message: 'Report is not awaiting the Quality Control signature.' });
    }

    const hasSigned = await ReportSignedPdf.exists(report.id);
    if (!hasSigned) {
      return res.status(400).json({ success: false, message: 'Please save your signed PDF before submitting to the Psychologist.' });
    }

    await db.query(`UPDATE psychological_reports SET signature_stage = 'psychologist', updated_at = NOW() WHERE id = $1`, [report.id]);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'submitted_to_psychologist', details: 'QC signature locked; submitted to Psychologist for signing', req });

    // Notify the psychologist who approved the report that their signature is required.
    try {
      const recipientId = report.approved_by || report.psychologist_id;
      if (recipientId) {
        await NotificationService.notifyUser(recipientId, 'report', 'Report Approved — Signature Required',
          `The report for ${report.client_name} requires your signature. Open it in Psych Reports to sign.`,
          `psych-reports.html?reportId=${report.id}`);
      }
    } catch (e) { console.warn('markSigned notification failed:', e.message); }

    res.json({ success: true, message: 'Submitted to the Psychologist for signing.' });
  } catch (err) {
    console.error('markSigned error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit to the Psychologist.' });
  }
};

// POST /api/reports/:id/submit-to-director
// Psychologist finalizes their signature → Ready For Release. The Clinical
// Director then performs the actual release. Requires a saved signed PDF.
exports.submitToDirector = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.signature_stage !== 'psychologist') {
      return res.status(400).json({ success: false, message: 'Report is not awaiting the Psychologist signature.' });
    }

    const hasSigned = await ReportSignedPdf.exists(report.id);
    if (!hasSigned) {
      return res.status(400).json({ success: false, message: 'Please save your signed PDF before submitting to the Clinical Director.' });
    }

    await db.query(`UPDATE psychological_reports SET signature_stage = 'ready_for_release', is_locked = TRUE, updated_at = NOW() WHERE id = $1`, [report.id]);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'submitted_to_director', details: 'All signatures locked; report Ready For Release', req });

    if (report.case_id) {
      try { await Case.updateStatus(report.case_id, 'Ready for Release', { staffId: req.user.id, ipAddress: req.ip }); }
      catch (e) { console.warn('submitToDirector case update skipped:', e.message); }
    }

    // Notify the Clinical Director that the report is ready to be released.
    // notifyRole reaches clinical_director accounts in BOTH the users table and
    // the staff table (notifyStaffRole alone would miss a users-table director),
    // so the director is always notified the moment a report is ready for release.
    // "View Report" opens it directly in Psych Reports (where the Release button is).
    try {
      await NotificationService.notifyRole('clinical_director', 'report', 'Report Ready to be Released',
        `The fully-signed report for ${report.client_name} has been submitted by the Psychologist and is ready to be released. Click to view it in Psych Reports.`,
        `psych-reports.html?reportId=${report.id}`);
    } catch (e) { console.warn('submitToDirector notification failed:', e.message); }

    res.json({ success: true, message: 'Submitted to the Clinical Director. Report is Ready For Release.' });
  } catch (err) {
    console.error('submitToDirector error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit to the Clinical Director.' });
  }
};

// POST /api/reports/:id/release
// Clinical Director releases the final signed PDF to the client.
exports.release = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.signature_stage !== 'ready_for_release') {
      return res.status(400).json({ success: false, message: 'Report is not Ready For Release.' });
    }

    const hasSigned = await ReportSignedPdf.exists(report.id);
    if (!hasSigned) {
      return res.status(400).json({ success: false, message: 'No final signed PDF is available to release.' });
    }

    // Resolve the exact client this report was made for (client_id → case.user_id).
    const clientUserId = await resolveReportClientId(report);
    if (!clientUserId) {
      return res.status(400).json({ success: false, message: 'Could not determine which client to release this report to (no linked client/case).' });
    }

    await db.query(
      `UPDATE psychological_reports SET signature_stage = 'released', status = 'finalized', client_id = COALESCE(client_id, $1), released_by = $2, released_at = NOW(), updated_at = NOW() WHERE id = $3`,
      [clientUserId, req.user.id, report.id]
    );
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'released', details: `Final signed report released to client #${clientUserId}`, req });

    if (report.case_id) {
      try { await Case.updateStatus(report.case_id, 'Released', { staffId: req.user.id, ipAddress: req.ip }); }
      catch (e) { console.warn('release case update skipped:', e.message); }
    }

    // Deliver to the exact client. "View Report" opens the signed PDF directly
    // (the client-report:<id> link is handled by the notifications page).
    try {
      await NotificationService.notifyUser(clientUserId, 'report', 'Your Psychological Report Has Been Released',
        'Your final psychological report has been released. Click View Report to open it.',
        `client-report:${report.id}`);
    } catch (e) { console.warn('release client notification failed:', e.message); }

    res.json({ success: true, message: 'Report released to the client.' });
  } catch (err) {
    console.error('release error:', err);
    res.status(500).json({ success: false, message: 'Failed to release report.' });
  }
};

// Resolve the client (users.id) a report belongs to: explicit client_id, else
// the linked case's user_id.
async function resolveReportClientId(report) {
  if (report.client_id) return report.client_id;
  if (report.case_id) {
    try {
      const caseData = await Case.findById(report.case_id);
      if (caseData) return caseData.user_id;
    } catch (_) { /* non-fatal */ }
  }
  return null;
}

// ── Client-facing: list a client's released reports ──────────────
// GET /api/reports/my-released  (role: client)
exports.listMyReleased = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, report_code, client_name, case_id, released_at, created_at
       FROM psychological_reports
       WHERE client_id = $1 AND signature_stage = 'released'
       ORDER BY released_at DESC NULLS LAST, created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, reports: result.rows });
  } catch (err) {
    console.error('listMyReleased error:', err);
    res.status(500).json({ success: false, message: 'Failed to load your reports.' });
  }
};

// ── Client-facing: download the final signed PDF of a released report ──
// GET /api/reports/:id/client-pdf  (role: client, must own the report)
exports.getClientPdf = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    // Only the owning client may fetch, and only once released.
    const clientUserId = await resolveReportClientId(report);
    if (report.signature_stage !== 'released' || String(clientUserId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const latestSigned = await ReportSignedPdf.getLatest(report.id);
    if (!latestSigned || !latestSigned.pdf_base64) {
      return res.status(404).json({ success: false, message: 'No signed PDF is available for this report.' });
    }
    const raw = String(latestSigned.pdf_base64).replace(/^data:application\/pdf;base64,/, '');
    const buffer = Buffer.from(raw, 'base64');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="PsychReport_${String(report.client_name || 'report').replace(/\s+/g, '_')}.pdf"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (err) {
    console.error('getClientPdf error:', err);
    res.status(500).json({ success: false, message: 'Failed to load report.' });
  }
};

// Step 2: after the field is placed/saved in the builder, create a submission
// from that template so the same user can sign it. Returns the embedded
// signing URL.
exports.createEsignSubmission = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    const { template_id } = req.body;
    if (!template_id) return res.status(400).json({ success: false, message: 'template_id is required.' });

    const signerEmail = req.user.email || req.body.email;
    const signerName = req.user.full_name || req.body.name || signerEmail || 'Signer';

    const submission = await DocuSealService.createSubmissionFromTemplate(
      template_id, signerEmail, signerName, 'Signer'
    );

    const submitter = Array.isArray(submission) ? submission[0] : (submission.submitters && submission.submitters[0]) || submission;
    const signingUrl = submitter?.embed_src || (submitter?.slug ? `https://docuseal.com/s/${submitter.slug}` : '');

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: 'E-signature submission created from template', req });

    res.json({ success: true, signing_url: signingUrl, submission: submitter });
  } catch (err) {
    console.error('E-sign submission error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to create signing submission.' });
  }
};
