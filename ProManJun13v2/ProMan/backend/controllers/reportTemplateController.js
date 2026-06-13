const ReportTemplate = require('../models/ReportTemplate');
const ReportAudit    = require('../services/reportAuditService');

// ── List Templates ─────────────────────────────────────────────
exports.listTemplates = async (req, res) => {
  try {
    const activeOnly = req.user.role !== 'clinical_director';
    const templates = await ReportTemplate.findAll(activeOnly);
    res.json({ success: true, templates });
  } catch (err) {
    console.error('List templates error:', err);
    res.status(500).json({ success: false, message: 'Failed to list templates.' });
  }
};

// ── Get Template ───────────────────────────────────────────────
exports.getTemplate = async (req, res) => {
  try {
    const template = await ReportTemplate.findById(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });
    res.json({ success: true, template });
  } catch (err) {
    console.error('Get template error:', err);
    res.status(500).json({ success: false, message: 'Failed to get template.' });
  }
};

// ── Create Template (Clinical Director) ────────────────────────
exports.createTemplate = async (req, res) => {
  try {
    const { name, description, template_type, sections_config } = req.body;
    if (!name || !template_type || !sections_config) {
      return res.status(400).json({ success: false, message: 'Name, type, and sections are required.' });
    }
    const template = await ReportTemplate.create({
      name, description, template_type, sections_config, created_by: req.user.id,
    });
    await ReportAudit.log({ reportId: null, userId: req.user.id, action: 'template_created', details: `Template created: ${name}`, req });
    res.status(201).json({ success: true, template });
  } catch (err) {
    console.error('Create template error:', err);
    res.status(500).json({ success: false, message: 'Failed to create template.' });
  }
};

// ── Update Template (Clinical Director) ────────────────────────
exports.updateTemplate = async (req, res) => {
  try {
    const template = await ReportTemplate.update(req.params.id, req.body);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });
    await ReportAudit.log({ reportId: null, userId: req.user.id, action: 'template_updated', details: `Template updated: ${template.name}`, req });
    res.json({ success: true, template });
  } catch (err) {
    console.error('Update template error:', err);
    res.status(500).json({ success: false, message: 'Failed to update template.' });
  }
};

// ── Delete Template (Clinical Director) ────────────────────────
exports.deleteTemplate = async (req, res) => {
  try {
    const existing = await ReportTemplate.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Template not found.' });
    await ReportTemplate.delete(req.params.id);
    await ReportAudit.log({ reportId: null, userId: req.user.id, action: 'template_deleted', details: `Template deleted: ${existing.name}`, req });
    res.json({ success: true, message: 'Template deleted.' });
  } catch (err) {
    if (err.code === '23503') { // FK violation
      return res.status(400).json({ success: false, message: 'Template is in use by reports and cannot be deleted. Deactivate it instead.' });
    }
    console.error('Delete template error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete template.' });
  }
};
