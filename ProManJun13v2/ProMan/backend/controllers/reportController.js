const PsychologicalReport = require('../models/PsychologicalReport');
const ReportTemplate       = require('../models/ReportTemplate');
const RuleEngine           = require('../services/ruleEngine');
const PdfGenerator         = require('../services/pdfGenerator');
const DocuSealService      = require('../services/docusealService');
const ReportAudit          = require('../services/reportAuditService');
const NotificationService  = require('../services/notificationService');
const db                   = require('../config/db');

// ── Create Report ──────────────────────────────────────────────
exports.createReport = async (req, res) => {
  try {
    const { template_id, client_name, client_age, client_gender, date_of_assessment } = req.body;
    if (!template_id || !client_name) {
      return res.status(400).json({ success: false, message: 'Template and client name are required.' });
    }

    const template = await ReportTemplate.findById(template_id);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });

    const report = await PsychologicalReport.create({
      template_id, psychologist_id: req.user.id,
      client_name, client_age, client_gender, date_of_assessment,
    });

    // Create sections from template
    const sections = template.sections_config || [];
    if (sections.length) {
      await PsychologicalReport.createSections(report.id, sections);
    }

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'created', details: `Report created using template: ${template.name}`, req });

    const fullReport = await PsychologicalReport.findById(report.id);
    const reportSections = await PsychologicalReport.getSections(report.id);

    res.status(201).json({ success: true, report: fullReport, sections: reportSections });
  } catch (err) {
    console.error('Create report error:', err);
    res.status(500).json({ success: false, message: 'Failed to create report.' });
  }
};

// ── List Reports ───────────────────────────────────────────────
exports.listReports = async (req, res) => {
  try {
    const { role } = req.user;
    let reports;
    if (role === 'clinical_director') {
      reports = await PsychologicalReport.findAll(req.query);
    } else if (role === 'psychologist') {
      reports = await PsychologicalReport.findByPsychologist(req.user.id);
    } else {
      return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
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

    // Access control
    if (req.user.role === 'psychologist' && report.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
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

// ── Update Report (client info) ────────────────────────────────
exports.updateReport = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    const _canEdit = report.psychologist_id === req.user.id ||
      (req.user.role === 'clinical_director' && report.status === 'finalized');
    if (!_canEdit) return res.status(403).json({ success: false, message: 'Access denied.' });
    // Finalized reports remain editable (the finalize step no longer hard-locks them).
    if (!['draft', 'rejected', 'finalized'].includes(report.status)) {
      return res.status(400).json({ success: false, message: 'Only draft, rejected, or finalized reports can be edited.' });
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
    const _canEdit = report.psychologist_id === req.user.id ||
      (req.user.role === 'clinical_director' && report.status === 'finalized');
    if (!_canEdit) return res.status(403).json({ success: false, message: 'Access denied.' });
    // Finalized reports remain editable (the finalize step no longer hard-locks them).
    if (!['draft', 'rejected', 'finalized'].includes(report.status)) {
      return res.status(400).json({ success: false, message: 'Only draft, rejected, or finalized reports can be edited.' });
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
  'test_results':    ['test_results', 'assessment_results_interpretations', 'overall_result'],
  'findings':        ['findings', 'summary', 'summary_formulation', 'impression_conclusion'],
  'recommendations': ['recommendations', 'recommendation'],
};

exports.generateNarratives = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    const _canEdit = report.psychologist_id === req.user.id ||
      (req.user.role === 'clinical_director' && report.status === 'finalized');
    if (!_canEdit) return res.status(403).json({ success: false, message: 'Access denied.' });
    // Finalized reports remain editable (the finalize step no longer hard-locks them).
    if (!['draft', 'rejected', 'finalized'].includes(report.status)) {
      return res.status(400).json({ success: false, message: 'Only draft, rejected, or finalized reports can be edited.' });
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

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: `Generated narrative (run #${genIndex})`, req });

    res.json({
      success: true,
      generated,                 // structured 3 sections for display
      narratives: savedNarratives,
      sections: updatedSections,
      generationIndex: genIndex,
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
    const _canEdit = report.psychologist_id === req.user.id ||
      (req.user.role === 'clinical_director' && report.status === 'finalized');
    if (!_canEdit) return res.status(403).json({ success: false, message: 'Access denied.' });
    // Finalized reports remain editable (the finalize step no longer hard-locks them).
    if (!['draft', 'rejected', 'finalized'].includes(report.status)) {
      return res.status(400).json({ success: false, message: 'Only draft, rejected, or finalized reports can be edited.' });
    }

    const { content } = req.body;
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
    if (report.status !== 'draft' && report.status !== 'rejected') {
      return res.status(400).json({ success: false, message: 'Only draft or rejected reports can be submitted.' });
    }

    const updated = await PsychologicalReport.updateStatus(req.params.id, 'submitted');
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'submitted', details: 'Report submitted for review', req });
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

    // Only finalized/approved reports, or draft for preview
    if (req.user.role === 'psychologist' && report.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const sections = await PsychologicalReport.getSections(report.id);
    const assessmentData = await PsychologicalReport.getAssessmentData(report.id);
    const approvals = await PsychologicalReport.getApprovals(report.id);

    const pdfBuffer = await PdfGenerator.generate(report, sections, assessmentData, approvals);

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

    const isOwner = report.psychologist_id === req.user.id;
    const isDirector = req.user.role === 'clinical_director';
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
    // A client may be chosen for report generation only when BOTH are true:
    //   1. Their intake form is finished and stored in `intake_forms`. (Per the
    //      clinic rule, an intake_forms row is created only after payment is
    //      verified — see services/intakePromote.js — so its existence already
    //      implies a completed transaction.)
    //   2. There is a payment whose status is 'verified' (verified & successful)
    //      linked to the appointment that owns this intake form.
    // We double-check the payment in the database with an explicit join rather
    // than trusting the intake row alone.
    const result = await db.query(
      `SELECT DISTINCT i.id AS intake_id, i.user_id, i.full_name, i.age, i.gender,
              i.date_of_birth, i.email, i.address, i.created_at,
              u.full_name AS account_name, u.email AS account_email
       FROM intake_forms i
       JOIN users u ON u.id = i.user_id
       JOIN appointments a ON a.intake_form_id = i.id
       JOIN payments p ON p.appointment_id = a.id AND p.status = 'verified'
       ORDER BY i.full_name ASC`
    );
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
    const pdfBuffer = await PdfGenerator.generate(report, sections, assessmentData, approvals);

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
    const pdfBuffer = await PdfGenerator.generate(report, sections, assessmentData, approvals);

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
