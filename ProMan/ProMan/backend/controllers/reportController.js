const PsychologicalReport = require('../models/PsychologicalReport');
const ReportTemplate       = require('../models/ReportTemplate');
const RuleEngine           = require('../services/ruleEngine');
const PdfGenerator         = require('../services/pdfGenerator');
const ReportAudit          = require('../services/reportAuditService');
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
    const testScores = await PsychologicalReport.getTestScores(report.id);
    const narratives = await PsychologicalReport.getNarratives(report.id);
    const approvals = await PsychologicalReport.getApprovals(report.id);

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'viewed', details: 'Report viewed', req });

    res.json({ success: true, report, sections, assessmentData, testScores, narratives, approvals });
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
    if (report.psychologist_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (report.status !== 'draft' && report.status !== 'rejected') {
      return res.status(400).json({ success: false, message: 'Only draft or rejected reports can be edited.' });
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
    if (report.psychologist_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });

    const data = await PsychologicalReport.upsertAssessmentData(req.params.id, req.body);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: 'Assessment data saved', req });
    res.json({ success: true, assessmentData: data });
  } catch (err) {
    console.error('Save assessment error:', err);
    res.status(500).json({ success: false, message: 'Failed to save assessment data.' });
  }
};

// ── Save Test Score ────────────────────────────────────────────
exports.saveTestScore = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.psychologist_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });

    const score = await PsychologicalReport.addTestScore(req.params.id, req.body);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: `Test score added: ${req.body.test_name}`, req });
    res.json({ success: true, testScore: score });
  } catch (err) {
    console.error('Save test score error:', err);
    res.status(500).json({ success: false, message: 'Failed to save test score.' });
  }
};

// ── Delete Test Score ──────────────────────────────────────────
exports.deleteTestScore = async (req, res) => {
  try {
    await PsychologicalReport.deleteTestScore(req.params.scoreId);
    res.json({ success: true, message: 'Test score deleted.' });
  } catch (err) {
    console.error('Delete test score error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete test score.' });
  }
};

// ── Generate Narratives (Rule Engine) ──────────────────────────

// Map rule engine section keys to possible report section keys across template types
const SECTION_KEY_MAP = {
  'test_results':    ['test_results', 'assessment_results_interpretations', 'overall_result'],
  'summary':         ['summary', 'findings', 'summary_formulation', 'impression_conclusion'],
  'recommendations': ['recommendations', 'recommendation'],
};

exports.generateNarratives = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (report.psychologist_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });

    const testScores = await PsychologicalReport.getTestScores(report.id);
    if (!testScores.length) {
      return res.status(400).json({ success: false, message: 'No test scores to generate narratives from.' });
    }

    // Clear old narratives and generate new ones
    await PsychologicalReport.clearNarratives(report.id);
    const narratives = RuleEngine.generateNarratives(testScores, report);

    // Save each narrative
    for (const n of narratives) {
      await PsychologicalReport.upsertNarrative(report.id, n.section_key, n.rule_id, n.narrative_text);
    }

    // Auto-populate sections with generated narratives
    const existingSections = await PsychologicalReport.getSections(report.id);
    for (const n of narratives) {
      // Find matching section using key mapping (handles different template types)
      const possibleKeys = SECTION_KEY_MAP[n.section_key] || [n.section_key];
      const section = existingSections.find(s => possibleKeys.includes(s.section_key));
      if (section) {
        const existingContent = section.content || '';
        const newContent = existingContent
          ? existingContent + '\n\n' + n.narrative_text
          : n.narrative_text;
        await PsychologicalReport.updateSection(report.id, section.section_key, newContent);
        // Update local copy so subsequent narratives append correctly
        section.content = newContent;
      }
    }

    const savedNarratives = await PsychologicalReport.getNarratives(report.id);
    const updatedSections = await PsychologicalReport.getSections(report.id);

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: `Generated ${narratives.length} narratives`, req });

    res.json({ success: true, narratives: savedNarratives, sections: updatedSections });
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
    if (report.psychologist_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });

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
    const testScores = await PsychologicalReport.getTestScores(report.id);
    const assessmentData = await PsychologicalReport.getAssessmentData(report.id);
    const approvals = await PsychologicalReport.getApprovals(report.id);

    let pdfBuffer = await PdfGenerator.generate(report, sections, testScores, assessmentData, approvals);

    // Stamp any saved e-signatures onto the PDF so they persist across downloads.
    const signatures = await PsychologicalReport.getSignatures(report.id);
    if (signatures.length) {
      pdfBuffer = await PdfGenerator.embedSignatures(pdfBuffer, signatures);
    }

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
    const result = await db.query(
      `SELECT i.id AS intake_id, i.user_id, i.full_name, i.age, i.gender,
              i.date_of_birth, i.email, i.address, i.status, i.created_at,
              u.full_name AS account_name, u.email AS account_email
       FROM intake_forms i
       JOIN users u ON u.id = i.user_id
       WHERE i.status IN ('approved', 'reviewed', 'pending')
       ORDER BY i.full_name ASC`
    );
    res.json({ success: true, clients: result.rows });
  } catch (err) {
    console.error('Get intake clients error:', err);
    res.status(500).json({ success: false, message: 'Failed to get intake clients.' });
  }
};

// ── E-Signature (in-app placement, embedded into the PDF) ───────
// Saves a drawn/uploaded signature plus its position & size. The signature is
// stamped onto the PDF whenever it is generated (see generatePdf + embedSignatures),
// so the placement persists and the signed PDF can be re-downloaded at any time.
exports.requestEsign = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });

    // Access control: psychologists can only sign their own reports
    if (req.user.role === 'psychologist' && report.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const { signature_image, x, y, width, height, page } = req.body;

    // Validate the signature image (must be a PNG/JPEG data URL)
    if (!signature_image || !/^data:image\/(png|jpe?g);base64,/i.test(signature_image)) {
      return res.status(400).json({ success: false, message: 'A valid signature image is required.' });
    }

    // Clamp placement to sane 0..1 fractions of the page (defaults = bottom-right block)
    const clamp01 = (v, d) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
    };
    const placement = {
      image:  signature_image,
      x:      clamp01(x, 0.6),
      y:      clamp01(y, 0.85),
      width:  clamp01(width, 0.25),
      height: clamp01(height, 0.08),
      page:   Math.max(1, parseInt(page, 10) || 1),
    };

    const saved = await PsychologicalReport.addSignature(report.id, req.user.id, placement);

    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: 'E-signature applied to report', req });

    return res.json({
      success: true,
      signature_applied: true,
      signature: saved,
      message: 'Signature applied successfully.',
    });
  } catch (err) {
    console.error('E-signature request error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to apply signature.' });
  }
};

// ── List saved signatures for a report ──────────────────────────
exports.listSignatures = async (req, res) => {
  try {
    const signatures = await PsychologicalReport.getSignatures(req.params.id);
    res.json({ success: true, signatures });
  } catch (err) {
    console.error('List signatures error:', err);
    res.status(500).json({ success: false, message: 'Failed to list signatures.' });
  }
};

// ── Remove a saved signature ────────────────────────────────────
exports.deleteSignature = async (req, res) => {
  try {
    const report = await PsychologicalReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    if (req.user.role === 'psychologist' && report.psychologist_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    await PsychologicalReport.deleteSignature(report.id, req.params.signatureId);
    await ReportAudit.log({ reportId: report.id, userId: req.user.id, action: 'edited', details: 'E-signature removed from report', req });
    res.json({ success: true, message: 'Signature removed.' });
  } catch (err) {
    console.error('Delete signature error:', err);
    res.status(500).json({ success: false, message: 'Failed to remove signature.' });
  }
};
