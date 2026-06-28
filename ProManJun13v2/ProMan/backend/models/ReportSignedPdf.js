const db = require('../config/db');

/**
 * Persisted signed-PDF versions for the signature workflow.
 *
 * PDFs are never overwritten — every save() creates a new version row so the
 * Supervising Psychometrician and Quality Control Psychometrician signatures
 * are preserved across refreshes, navigation, stage changes, and release.
 * The latest row (highest version_number) is always the authoritative copy.
 */
const ReportSignedPdf = {
  /**
   * Save a new signed-PDF version. version_number auto-increments per report.
   * @returns the inserted row (without the heavy pdf_base64 payload).
   */
  async save(reportId, { pdfBase64, signatureStage, signedBy }) {
    const next = await db.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS v FROM report_signed_pdfs WHERE report_id = $1`,
      [reportId]
    );
    const versionNumber = next.rows[0].v;
    const r = await db.query(
      `INSERT INTO report_signed_pdfs (report_id, version_number, signature_stage, pdf_base64, signed_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, report_id, version_number, signature_stage, signed_by, created_at`,
      [reportId, versionNumber, signatureStage || null, pdfBase64, signedBy || null]
    );
    return r.rows[0];
  },

  /** Latest saved signed-PDF version for a report (includes pdf_base64). */
  async getLatest(reportId) {
    const r = await db.query(
      `SELECT * FROM report_signed_pdfs
       WHERE report_id = $1
       ORDER BY version_number DESC
       LIMIT 1`,
      [reportId]
    );
    return r.rows[0] || null;
  },

  /** True if any signed PDF has been saved for this report. */
  async exists(reportId) {
    const r = await db.query(
      `SELECT 1 FROM report_signed_pdfs WHERE report_id = $1 LIMIT 1`,
      [reportId]
    );
    return r.rowCount > 0;
  },

  /** True if a signed PDF has been saved for this report AT a specific stage. */
  async existsForStage(reportId, stage) {
    if (!stage) return false;
    const r = await db.query(
      `SELECT 1 FROM report_signed_pdfs WHERE report_id = $1 AND signature_stage = $2 LIMIT 1`,
      [reportId, stage]
    );
    return r.rowCount > 0;
  },

  /** Version history metadata (no payloads) — kept internally even if hidden in UI. */
  async listVersions(reportId) {
    const r = await db.query(
      `SELECT id, version_number, signature_stage, signed_by, created_at
       FROM report_signed_pdfs
       WHERE report_id = $1
       ORDER BY version_number DESC`,
      [reportId]
    );
    return r.rows;
  },
};

module.exports = ReportSignedPdf;
