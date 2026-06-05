const db = require('../config/db');

const PsychologicalReport = {
  async create({ template_id, psychologist_id, client_name, client_age, client_gender, date_of_assessment }) {
    const r = await db.query(
      `INSERT INTO psychological_reports
         (template_id, psychologist_id, client_name, client_age, client_gender, date_of_assessment)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [template_id, psychologist_id, client_name, client_age, client_gender, date_of_assessment]
    );
    return r.rows[0];
  },

  async findById(id) {
    const r = await db.query(
      `SELECT pr.*, rt.name AS template_name, rt.template_type, rt.sections_config,
              u.full_name AS psychologist_name
       FROM psychological_reports pr
       JOIN report_templates rt ON pr.template_id = rt.id
       JOIN users u ON pr.psychologist_id = u.id
       WHERE pr.id = $1`, [id]
    );
    return r.rows[0] || null;
  },

  async findByPsychologist(psychologistId) {
    const r = await db.query(
      `SELECT pr.*, rt.name AS template_name, rt.template_type
       FROM psychological_reports pr
       JOIN report_templates rt ON pr.template_id = rt.id
       WHERE pr.psychologist_id = $1
       ORDER BY pr.updated_at DESC`, [psychologistId]
    );
    return r.rows;
  },

  async findPendingReview() {
    const r = await db.query(
      `SELECT pr.*, rt.name AS template_name, rt.template_type,
              u.full_name AS psychologist_name
       FROM psychological_reports pr
       JOIN report_templates rt ON pr.template_id = rt.id
       JOIN users u ON pr.psychologist_id = u.id
       WHERE pr.status = 'submitted'
       ORDER BY pr.updated_at ASC`
    );
    return r.rows;
  },

  async findAll(filters = {}) {
    let q = `SELECT pr.*, rt.name AS template_name, rt.template_type,
                    u.full_name AS psychologist_name
             FROM psychological_reports pr
             JOIN report_templates rt ON pr.template_id = rt.id
             JOIN users u ON pr.psychologist_id = u.id`;
    const params = [];
    const conds = [];
    let idx = 1;
    if (filters.status) { conds.push(`pr.status = $${idx++}`); params.push(filters.status); }
    if (filters.psychologist_id) { conds.push(`pr.psychologist_id = $${idx++}`); params.push(filters.psychologist_id); }
    if (conds.length) q += ` WHERE ` + conds.join(' AND ');
    q += ` ORDER BY pr.updated_at DESC`;
    const r = await db.query(q, params);
    return r.rows;
  },

  async updateStatus(id, status) {
    const r = await db.query(
      `UPDATE psychological_reports SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return r.rows[0] || null;
  },

  async incrementVersion(id) {
    const r = await db.query(
      `UPDATE psychological_reports SET current_version = current_version + 1, updated_at = NOW()
       WHERE id = $1 RETURNING current_version`, [id]
    );
    return r.rows[0]?.current_version;
  },

  async updateClient(id, { client_name, client_age, client_gender, date_of_assessment }) {
    const r = await db.query(
      `UPDATE psychological_reports
       SET client_name = COALESCE($1, client_name),
           client_age = COALESCE($2, client_age),
           client_gender = COALESCE($3, client_gender),
           date_of_assessment = COALESCE($4, date_of_assessment),
           updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [client_name, client_age, client_gender, date_of_assessment, id]
    );
    return r.rows[0] || null;
  },

  // --- Sections ---
  async createSections(reportId, sections) {
    const values = sections.map((s, i) => {
      const defaultContent = (s.default_content || '').replace(/'/g, "''");
      return `($1, '${s.key}', '${s.title.replace(/'/g, "''")}', '${defaultContent}', ${i})`;
    }).join(',');
    await db.query(
      `INSERT INTO report_sections (report_id, section_key, section_title, content, sort_order)
       VALUES ${values} ON CONFLICT (report_id, section_key) DO NOTHING`, [reportId]
    );
  },

  async getSections(reportId) {
    const r = await db.query(
      `SELECT * FROM report_sections WHERE report_id = $1 ORDER BY sort_order`, [reportId]
    );
    return r.rows;
  },

  async updateSection(reportId, sectionKey, content) {
    const r = await db.query(
      `UPDATE report_sections SET content = $1, updated_at = NOW()
       WHERE report_id = $2 AND section_key = $3 RETURNING *`,
      [content, reportId, sectionKey]
    );
    return r.rows[0] || null;
  },

  // --- Assessment Data ---
  async upsertAssessmentData(reportId, data) {
    const r = await db.query(
      `INSERT INTO assessment_data (report_id, tests_administered, observational_notes, behavioral_observations, interview_findings, additional_data)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (report_id) DO UPDATE SET
         tests_administered = $2, observational_notes = $3,
         behavioral_observations = $4, interview_findings = $5,
         additional_data = $6, updated_at = NOW()
       RETURNING *`,
      [reportId, data.tests_administered || [], data.observational_notes || '',
       data.behavioral_observations || '', data.interview_findings || '',
       JSON.stringify(data.additional_data || {})]
    );
    return r.rows[0];
  },

  async getAssessmentData(reportId) {
    const r = await db.query(`SELECT * FROM assessment_data WHERE report_id = $1`, [reportId]);
    return r.rows[0] || null;
  },

  // --- Test Scores ---
  async addTestScore(reportId, score) {
    const r = await db.query(
      `INSERT INTO test_scores (report_id, test_name, test_category, raw_score, percentile_score, standard_score, scaled_score, descriptive_range, interpretation_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [reportId, score.test_name, score.test_category, score.raw_score,
       score.percentile_score, score.standard_score, score.scaled_score,
       score.descriptive_range, score.interpretation_notes || '']
    );
    return r.rows[0];
  },

  async getTestScores(reportId) {
    const r = await db.query(
      `SELECT * FROM test_scores WHERE report_id = $1 ORDER BY created_at`, [reportId]
    );
    return r.rows;
  },

  async deleteTestScore(scoreId) {
    await db.query(`DELETE FROM test_scores WHERE id = $1`, [scoreId]);
  },

  // --- Narratives ---
  async upsertNarrative(reportId, sectionKey, ruleId, text) {
    const r = await db.query(
      `INSERT INTO generated_narratives (report_id, section_key, rule_id, narrative_text)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING RETURNING *`,
      [reportId, sectionKey, ruleId, text]
    );
    return r.rows[0];
  },

  async getNarratives(reportId) {
    const r = await db.query(
      `SELECT * FROM generated_narratives WHERE report_id = $1 ORDER BY section_key`, [reportId]
    );
    return r.rows;
  },

  async clearNarratives(reportId) {
    await db.query(`DELETE FROM generated_narratives WHERE report_id = $1`, [reportId]);
  },

  // --- Versions ---
  async createVersion(reportId, editorId, snapshotData, modifiedSections, changeSummary) {
    // Get current version number
    const report = await db.query(`SELECT current_version FROM psychological_reports WHERE id = $1`, [reportId]);
    const vnum = report.rows[0]?.current_version || 1;
    const r = await db.query(
      `INSERT INTO report_versions (report_id, version_number, editor_id, sections_snapshot, modified_sections, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [reportId, vnum, editorId, JSON.stringify(snapshotData), modifiedSections, changeSummary]
    );
    return r.rows[0];
  },

  async getVersions(reportId) {
    const r = await db.query(
      `SELECT rv.*, u.full_name AS editor_name
       FROM report_versions rv
       LEFT JOIN users u ON rv.editor_id = u.id
       WHERE rv.report_id = $1
       ORDER BY rv.version_number DESC`, [reportId]
    );
    return r.rows;
  },

  async getVersion(versionId) {
    const r = await db.query(`SELECT * FROM report_versions WHERE id = $1`, [versionId]);
    return r.rows[0] || null;
  },

  // --- Approvals ---
  async createApproval(reportId, reviewerId, decision, comments) {
    const r = await db.query(
      `INSERT INTO report_approvals (report_id, reviewer_id, decision, comments)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [reportId, reviewerId, decision, comments]
    );
    return r.rows[0];
  },

  async getApprovals(reportId) {
    const r = await db.query(
      `SELECT ra.*, u.full_name AS reviewer_name
       FROM report_approvals ra
       JOIN users u ON ra.reviewer_id = u.id
       WHERE ra.report_id = $1
       ORDER BY ra.created_at DESC`, [reportId]
    );
    return r.rows;
  },

  // ── E-Signatures ────────────────────────────────────────────
  async addSignature(reportId, signerId, { image, x, y, width, height, page }) {
    const r = await db.query(
      `INSERT INTO report_signatures
         (report_id, signer_id, image_data, pos_x, pos_y, width, height, page_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [reportId, signerId, image, x, y, width, height, page]
    );
    return r.rows[0];
  },

  async getSignatures(reportId) {
    const r = await db.query(
      `SELECT * FROM report_signatures WHERE report_id = $1 ORDER BY created_at ASC`,
      [reportId]
    );
    return r.rows;
  },

  async deleteSignature(reportId, signatureId) {
    await db.query(
      `DELETE FROM report_signatures WHERE id = $1 AND report_id = $2`,
      [signatureId, reportId]
    );
  },

  async clearSignatures(reportId) {
    await db.query(`DELETE FROM report_signatures WHERE report_id = $1`, [reportId]);
  },
};

module.exports = PsychologicalReport;
