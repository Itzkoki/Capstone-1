/**
 * PDF Report Generator using PDFGeneratorAPI + PDFKit fallback
 * Green-themed with Barcarse logo and CONFIDENTIAL watermark.
 */

const path = require('path');
const fs = require('fs');

const PDF_API_KEY = process.env.PDF_GENERATOR_API_KEY || '';
const PDF_API_URL = 'https://us1.pdfgeneratorapi.com/api/v4/documents/generate';

// Load logo as base64 for HTML embedding
const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'barcarse-logo.jpg');
let LOGO_BASE64 = '';
try {
  const logoBuffer = fs.readFileSync(LOGO_PATH);
  LOGO_BASE64 = logoBuffer.toString('base64');
} catch (e) {
  console.warn('Logo file not found at', LOGO_PATH);
}

// Green theme colors matching Barcarse system
const COLORS = {
  primary: '#1E3A8A',     // royal blue
  secondary: '#15306E',   // royal blue deep
  accent: '#C0922E',      // gold accent
  accentLight: '#D4A94A', // gold light
  dark: '#1B2230',
  text: '#475467',
  muted: '#98A2B3',
  border: '#E4E7EC',
  bgLight: '#F8FAFC',
  white: '#ffffff',
  watermark: 'rgba(30, 58, 138, 0.06)',
};

// ─── Standardized document layout (applied to BOTH output paths) ───
// A4 portrait, 1-inch (72pt) margins on all sides. These constants are the
// single source of truth for the PDFKit fallback geometry so every report —
// regardless of type or content length — lays out identically.
const PAGE_SIZE = 'A4';
const MARGIN = 72;           // 1 inch = 72pt (top/bottom/left/right)
const BODY_FONT_PT = 12;     // body text
const HEADING_FONT_PT = 13;  // section titles / headings (bold, uppercase)
const BODY_LINE_GAP = 2;     // ≈ 1.15 line spacing at 12pt body
const PARA_INDENT = 24;      // first-line paragraph indent (preserved)

// Cambria font paths for PDFKit fallback (available on Windows; graceful fall-through)
const _CAMBRIA = 'C:\\Windows\\Fonts\\cambria.ttf';
const _CAMBRIA_B = 'C:\\Windows\\Fonts\\cambriab.ttf';
const _CAMBRIA_I = 'C:\\Windows\\Fonts\\cambriai.ttf';
const _CAMBRIA_BI = 'C:\\Windows\\Fonts\\cambriaz.ttf';
const FONT_REGULAR = fs.existsSync(_CAMBRIA)   ? _CAMBRIA   : 'Times-Roman';
const FONT_BOLD    = fs.existsSync(_CAMBRIA_B) ? _CAMBRIA_B : 'Times-Bold';
const FONT_ITALIC  = fs.existsSync(_CAMBRIA_I) ? _CAMBRIA_I : 'Times-Italic';
const FONT_BOLD_ITALIC = fs.existsSync(_CAMBRIA_BI) ? _CAMBRIA_BI : 'Times-BoldItalic';

const PdfGenerator = {
  async generate(report, sections, assessmentData, approvals, options = {}) {
    const html = this._buildHtml(report, sections, assessmentData, approvals, options);

    // Only attempt PDFGeneratorAPI if a valid key is configured and non-empty
    if (PDF_API_KEY && PDF_API_KEY.length > 20) {
      try {
        const response = await fetch(PDF_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${PDF_API_KEY}`,
          },
          body: JSON.stringify({
            paper_size: 'A4',
            landscape: false,
            filename: `PsychReport_${(report.client_name || 'Report').replace(/\s+/g, '_')}_${report.id}`,
            content: html,
          }),

        });

        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/pdf')) {
            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
          }
          const data = await response.json();
          if (data.response) {
            return Buffer.from(data.response, 'base64');
          }
        }
        // Only log non-auth errors (401 means invalid/expired key — skip silently)
        if (response.status !== 401) {
          console.warn('PDFGeneratorAPI status:', response.status, '- falling back to PDFKit');
        }
      } catch (err) {
        console.warn('PDFGeneratorAPI error, falling back to PDFKit:', err.message);
      }
    }

    return this._generateWithPdfKit(report, sections, assessmentData, approvals, options);
  },

  // ─── HTML Builder ────────────────────────────────────────────
  _buildHtml(report, sections, assessmentData, approvals, options = {}) {
    const templateName = (report.template_name || report.template_type || '').toUpperCase();
    const assessDate = report.date_of_assessment
      ? new Date(report.date_of_assessment).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
      : 'N/A';
    const approval = approvals && approvals.find(a => a.decision === 'approved');

    const lhLogo = LOGO_BASE64
      ? `<img src="data:image/jpeg;base64,${LOGO_BASE64}" class="lh-logo" alt="BPS Logo">`
      : '';
    const letterhead = `
  <div class="letterhead">
    ${lhLogo}
    <div class="lh-text">
      <div class="lh-org">Barcarse Psychological Services</div>
      <div class="lh-rule"></div>
      <div class="lh-line">Psychological Clinic Services</div>
      <div class="lh-line bold">Psychological Assessment Section</div>
      <div class="lh-loc">Sampaloc, Manila, Philippines</div>
    </div>
  </div>
  <div class="lh-accent"></div>`;

    // Section titles are numbered with Roman numerals (I., II., III., …) in
    // document order. Numbering is applied purely at render time; stored
    // section titles are never modified.
    const visibleSections = sections
      .filter(s => s.section_key !== 'prepared_approved_by')
      .filter(s => s.section_key !== 'mental_health_certificate')
      .filter(s => s.content || s.section_key === 'identifying_information');
    let romanIdx = 0;
    const sectionsHtml = visibleSections
      .map(s => {
        romanIdx += 1;
        const heading = `${this._toRoman(romanIdx)}. ${this._esc(s.section_title)}`;
        const tbl = this._extractTableBlock(s.content);
        let body;
        if (tbl) {
          const thead = `<tr>${tbl.headers.map(h => `<th>${this._esc(h)}</th>`).join('')}</tr>`;
          const tbody = tbl.rows.map(r => `<tr>${r.map(c => `<td>${this._esc(c)}</td>`).join('')}</tr>`).join('');
          // Intro/outro prose around a table is not first-line indented.
          const beforeHtml = tbl.before ? this._paragraphsHtml(tbl.before, false) : '';
          const afterHtml = tbl.after ? this._paragraphsHtml(tbl.after, false) : '';
          body = `${beforeHtml}<table class="tools-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>${afterHtml}`;
        } else {
          // Narrative sections get a first-line paragraph indent; the key/value
          // "Identifying Information" block does not (it is a labelled list).
          const indent = s.section_key !== 'identifying_information';
          body = this._paragraphsHtml(s.content || '(No content)', indent);
        }
        return `<div class="section"><h2>${heading}</h2>${body}</div>`;
      }).join('');

    // ── Assessment Tools / Procedure (dynamic, data-driven) ──
    // Suppress when assessment_tests in additional_data already covers it via a section [[TESTS_TABLE]]
    const _hasStructuredBattery = !!(assessmentData && assessmentData.additional_data &&
      Array.isArray(assessmentData.additional_data.assessment_tests) &&
      assessmentData.additional_data.assessment_tests.length > 0);
    const tools = _hasStructuredBattery ? [] : this._collectAssessmentTools(assessmentData);
    let toolsHtml = '';
    if (tools.length) {
      const cols = this._activeToolColumns(tools);
      const headCells = ['<th class="tool-name-col">Assessment Tool / Test</th>'];
      if (cols.category)   headCells.push('<th>Category</th>');
      if (cols.raw)        headCells.push('<th>Raw</th>');
      if (cols.standard)   headCells.push('<th>Standard</th>');
      if (cols.scaled)     headCells.push('<th>Scaled</th>');
      if (cols.percentile) headCells.push('<th>%ile</th>');
      if (cols.range)      headCells.push('<th>Descriptive Range</th>');
      if (cols.notes)      headCells.push('<th>Interpretation</th>');

      const cell = (v) => this._hasVal(v) ? this._esc(v) : '—';
      const rows = tools.map((t) => {
        const cells = [`<td class="tool-name-col"><strong>${this._esc(t.name)}</strong></td>`];
        if (cols.category)   cells.push(`<td>${cell(t.category)}</td>`);
        if (cols.raw)        cells.push(`<td>${cell(t.raw)}</td>`);
        if (cols.standard)   cells.push(`<td>${cell(t.standard)}</td>`);
        if (cols.scaled)     cells.push(`<td>${cell(t.scaled)}</td>`);
        if (cols.percentile) cells.push(`<td>${cell(t.percentile)}</td>`);
        if (cols.range)      cells.push(`<td>${cell(t.range)}</td>`);
        if (cols.notes)      cells.push(`<td class="tool-notes-col">${cell(t.notes)}</td>`);
        return `<tr>${cells.join('')}</tr>`;
      }).join('');

      romanIdx += 1;
      toolsHtml = `
        <div class="section">
          <h2>${this._toRoman(romanIdx)}. Assessment Tools / Procedure</h2>
          <table class="tools-table">
            <thead><tr>${headCells.join('')}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    // ── Mental Health Certificate (separate final page, opt-in only) ──
    const approvedByName = this._esc(report.approved_by_name || '');
    const dateIssued = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const certAddress    = this._esc(options.certAddress    || '');
    const certPurpose    = this._esc(options.certPurpose    || '');
    const certImpression = this._esc(this._capitalizeSentences(options.certImpression || ''));
    const certValidity   = this._esc(options.certValidity   || '');
    const certLicenseNo  = this._esc(options.certLicenseNo  || '');
    const certPtrNo      = this._esc(options.certPtrNo      || '');
    const certLicValid   = this._esc(options.certLicenseValidity || '');

    const certificateHtml = options.includeCertificate ? `
      <div class="certificate-page">
        ${letterhead}
        <div class="cert-title">Mental Health Certificate</div>
        <div class="content">

          <p class="cert-intro" style="margin-bottom:16px;font-weight:700;">TO WHOM IT MAY CONCERN:</p>

          <p class="cert-intro">
            This is to certify that <strong>${this._esc(report.client_name || '')}</strong>${certAddress ? ', of <strong>' + certAddress + '</strong>' : ''},
            was examined and evaluated at <strong>Barcarse Psychological Services</strong>,
            Sampaloc, Manila, Philippines.
          </p>

          <p class="cert-intro">
            Based on the results of the psychological evaluation conducted on <strong>${assessDate}</strong>,
            the psychological impression noted is as follows:
          </p>

          <div style="border:1px solid #E4E7EC;border-radius:6px;padding:12px 16px;margin:12px 0;background:#F8FAFC;font-size:12pt;color:#000000;line-height:1.7;font-weight:700;font-style:italic;min-height:64px;display:flex;align-items:center;justify-content:center;text-align:center;">
            ${certImpression || '<em style="color:#98A2B3;">(Psychological impression / diagnosis not specified)</em>'}
          </div>

          <p class="cert-intro">
            This certificate is issued upon the request of <strong>${this._esc(report.client_name || '')}</strong>
            for <strong>${certPurpose || '(purpose not specified)'}</strong> purposes only,
            and is valid until <strong>${certValidity || '(validity not specified)'}</strong>.
          </p>

          <p class="cert-intro" style="margin-top:6px;">
            Date Issued: <strong>${dateIssued}</strong>
          </p>

          <div class="cert-staff-grid">
            <div class="cert-staff-block">
              <div class="cert-sig-line"></div>
              <div class="cert-sig-name">${approvedByName || '________________________________'}</div>
              <div class="cert-sig-role">Licensed Psychologist</div>
              <div style="font-size:12pt;color:#000000;margin-top:6px;line-height:1.8;">
                Barcarse Psychological Services – Psychological Assessment Section<br>
                Psychologist License No.: ${certLicenseNo || '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;'}<br>
                License Valid Until: ${certLicValid || '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;'}<br>
                PTR No.: ${certPtrNo || '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;'}
              </div>
            </div>
          </div>

          <div class="pdf-footer">
            CONFIDENTIAL — This certificate is confidential and intended solely for the use of the individual or entity to which it is addressed.
          </div>
        </div>
      </div>` : '';



    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  /* A4 portrait, 1-inch margins on all sides */
  @page { size: A4 portrait; margin: 1in; }

  body { font-family: 'Cambria', Georgia, serif; font-size: 12pt; color: #000000; line-height: 1.15; }

  /* CONFIDENTIAL watermark on every page — sized and centred so the full word
     is always visible (never clipped) regardless of page content length. */
  @media print {
    body::after { content: 'CONFIDENTIAL'; position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-45deg); font-size: 90px; font-weight: 900; color: rgba(30,58,138,0.06); letter-spacing: 10px; pointer-events: none; z-index: 0; white-space: nowrap; }
  }
  .watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-45deg); font-size: 90px; font-weight: 900; color: rgba(30,58,138,0.06); letter-spacing: 10px; pointer-events: none; z-index: 0; white-space: nowrap; }

  /* Letterhead — matches the printed clinic letterhead.
     Horizontal padding is 0 so content aligns to the 1-inch @page margin. */
  .letterhead { display: flex; align-items: center; gap: 18px; padding: 0 0 12px; }
  .lh-logo { width: 88px; height: 88px; border-radius: 50%; flex: 0 0 auto; object-fit: cover; }
  .lh-text { flex: 1; font-family: 'Cambria', Georgia, serif; color: #1B2230; }
  .lh-org { font-size: 25px; font-weight: 700; line-height: 1.05; }
  .lh-rule { border-bottom: 1.5px solid #1B2230; margin: 5px 0 6px; }
  .lh-line { font-size: 14px; line-height: 1.35; color: #1B2230; }
  .lh-line.bold { font-weight: 700; }
  .lh-loc { font-size: 12.5px; font-style: italic; margin-top: 3px; color: #1B2230; }
  .lh-accent { height: 3px; background: #C0922E; }

  /* Document title block (below header, before client information) */
  .report-title-block { text-align: center; padding: 14px 0 6px; }
  .report-title { font-size: 15px; font-weight: 700; color: #1E3A8A; letter-spacing: 2px; text-transform: uppercase; }
  /* Single-line CONFIDENTIAL label, centred beneath the report title */
  .report-confidential { display: block; margin-top: 5px; font-size: 10px; font-weight: 700; color: #B42318; letter-spacing: 3px; text-transform: uppercase; white-space: nowrap; }
  .report-type { display: inline-block; margin-top: 6px; font-size: 9.5px; font-weight: 600; color: #8A6A18; letter-spacing: 1.5px; text-transform: uppercase; border-top: 1px solid #E4E7EC; padding-top: 5px; }
  .cert-title { text-align: center; padding: 14px 0 6px; font-size: 16px; font-weight: 700; color: #1E3A8A; letter-spacing: 2px; text-transform: uppercase; }

  .content { padding: 16px 0; position: relative; z-index: 1; }

  .section { margin-bottom: 12px; }
  /* Avoid orphaned headings: keep the title with the content that follows it */
  .section h2 { font-size: 13pt; color: #1E3A8A; text-transform: uppercase; text-align: left; letter-spacing: 0.8px; font-weight: 700; padding-bottom: 4px; border-bottom: 2px solid #C0922E; margin-top: 12px; margin-bottom: 8px; page-break-after: avoid; }
  /* Body text: 12pt, justified, 1.15 line spacing with clean paragraph separation.
     All body/narrative text is rendered black for readability. */
  .section-content { font-size: 12pt; color: #000000; line-height: 1.15; text-align: justify; }
  .section-content p { margin: 0 0 7px; }
  .section-content p:last-child { margin-bottom: 0; }
  /* First-line indent for narrative paragraphs (not lists, tables or signatures) */
  .section-content.narrative p { text-indent: 2em; }



  .signatures { display: flex; justify-content: space-between; margin-top: 24px; padding-top: 12px; border-top: 2px solid #C0922E; page-break-inside: avoid; }
  .sig-block { width: 45%; }
  /* Signature labels use 12pt Cambria, black */
  .sig-label { font-size: 12pt; color: #000000; margin-bottom: 24px; }
  .sig-line { border-bottom: 1px solid #000000; margin-bottom: 6px; }
  .sig-name { font-size: 12pt; font-weight: 700; color: #000000; }
  .sig-title { font-size: 10pt; color: #000000; }

  .pdf-footer { text-align: center; font-size: 7px; color: #000000; margin-top: 16px; padding-top: 6px; border-top: 1px solid #E4E7EC; }

  /* Tables span the full content width with visible borders on every cell.
     The header row repeats across page breaks and rows never split. */
  .tools-table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 12pt; page-break-inside: auto; }
  .tools-table thead { display: table-header-group; }
  .tools-table tr { page-break-inside: avoid; }
  .tools-table th { background: #1E3A8A; color: #ffffff; text-align: center; vertical-align: middle; padding: 6px 8px; font-weight: 700; font-size: 12pt; letter-spacing: 0.3px; border: 1px solid #1B2230; }
  /* Table content: 12pt Cambria, black, centred horizontally and vertically */
  .tools-table td { padding: 5px 8px; border: 1px solid #C9CDD4; color: #000000; text-align: center; vertical-align: middle; font-size: 12pt; }
  .tools-table tbody tr:nth-child(even) { background: #F8FAFC; }
  .tools-table .tool-name-col { width: 26%; }
  .tools-table .tool-name-col strong { color: #000000; font-weight: 600; }
  .tools-table .tool-notes-col { color: #000000; }

  /* Mental Health Certificate page */
  .certificate-page { page-break-before: always; }
  .cert-intro { font-size: 12pt; color: #000000; line-height: 1.5; text-align: justify; margin-bottom: 18px; }
  .cert-staff-grid { display: flex; flex-wrap: wrap; gap: 28px 40px; margin-top: 28px; }
  .cert-staff-block { width: 42%; min-width: 220px; }
  .cert-sig-line { border-bottom: 1px solid #000000; height: 28px; margin-bottom: 6px; }
  .cert-sig-name { font-size: 12pt; font-weight: 700; color: #000000; }
  .cert-sig-role { font-size: 12pt; color: #000000; }
  .cert-staff-empty { font-size: 10px; color: #000000; font-style: italic; }
</style>
</head>
<body>
  <div class="watermark">CONFIDENTIAL</div>

  ${letterhead}

  <div class="report-title-block">
    <div class="report-title">Psychological Assessment Report</div>
    <div class="report-confidential">CONFIDENTIAL</div>
    ${templateName ? `<div class="report-type">${this._esc(templateName)}</div>` : ''}
  </div>

  <div class="content">
    ${sectionsHtml}

    ${toolsHtml}

    <div class="signatures">
      <div class="sig-block">
        <div class="sig-label">Prepared By:</div>
        <div class="sig-line"></div>
        <div class="sig-name">${this._esc(report.prepared_by_name || '___________________')}</div>
        <div class="sig-title">Supervising Psychometrician</div>
      </div>
      <div class="sig-block">
        <div class="sig-label">Reviewed By:</div>
        <div class="sig-line"></div>
        <div class="sig-name">${this._esc(report.reviewed_by_name || '___________________')}</div>
        <div class="sig-title">Quality Control Psychometrician</div>
      </div>
      <div class="sig-block">
        <div class="sig-label">Approved By:</div>
        <div class="sig-line"></div>
        <div class="sig-name">${this._esc(report.approved_by_name || '___________________')}</div>
        <div class="sig-title">Psychologist</div>
      </div>
    </div>

    <div class="pdf-footer">
      CONFIDENTIAL — This report is confidential and intended solely for the use of the individual or entity to which it is addressed.
    </div>
  </div>

  ${certificateHtml}
</body>
</html>`;
  },

  // ─── PDFKit Fallback ─────────────────────────────────────────
  async _generateWithPdfKit(report, sections, assessmentData, approvals, options = {}) {
    const PDFDocument = require('pdfkit');

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: PAGE_SIZE,
          bufferPages: true,
          margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
          info: {
            Title: `Psychological Assessment Report - ${report.client_name}`,
            Author: report.psychologist_name || 'Barcarse Psychological Services',
            Subject: 'Psychological Assessment Report',
            Creator: 'Barcarse Psychological Services',
          },
        });

        const buffers = [];
        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        // Shared content geometry (1-inch margins on all sides).
        const left = MARGIN;
        const right = doc.page.width - MARGIN;
        const contentW = right - left;
        // Content must never flow into the 1-inch bottom margin.
        const bottomLimit = doc.page.height - MARGIN;

        // ── Letterhead (matches the printed clinic letterhead) ──
        this._pdfLetterhead(doc);

        // ── Document title + test type (below header, before client info) ──
        doc.font(FONT_BOLD).fontSize(HEADING_FONT_PT).fillColor(COLORS.primary)
           .text('PSYCHOLOGICAL ASSESSMENT REPORT', left, doc.y, { align: 'center', width: contentW, characterSpacing: 1.5 });
        // Centred, single-line CONFIDENTIAL label beneath the title (no wrapping).
        doc.font(FONT_BOLD).fontSize(8.5).fillColor('#B42318')
           .text('CONFIDENTIAL', left, doc.y + 3, { align: 'center', width: contentW, characterSpacing: 2.5, lineBreak: false });
        const typeName = (report.template_name || report.template_type || '').toUpperCase();
        if (typeName) {
          doc.font(FONT_REGULAR).fontSize(8.5).fillColor('#8A6A18')
             .text(typeName, left, doc.y + 3, { align: 'center', width: contentW, characterSpacing: 1 });
        }
        doc.fillColor(COLORS.dark);
        doc.y += 10;

        // The client summary box was intentionally removed: the same client
        // details already appear in "I. IDENTIFYING INFORMATION", so the body
        // now flows straight from the title block into the numbered sections.

        // ── Sections ──
        // Titles are numbered with Roman numerals (I., II., III., …) in document
        // order, matching the HTML path. Numbering is render-only; stored
        // section titles are never modified.
        const _visible = sections.filter(s =>
          s.section_key !== 'mental_health_certificate' &&
          (s.content || s.section_key === 'identifying_information'));
        let _roman = 0;
        for (const section of _visible) {
          _roman += 1;
          // Orphan control: keep the heading with the first lines of its body.
          // If a heading + a few lines would not fit, start a fresh page first.
          if (doc.y > bottomLimit - 60) { doc.addPage(); this._pdfPageHeader(doc, report); }
          this._pdfSectionHeading(doc, `${this._toRoman(_roman)}. ${section.section_title.toUpperCase()}`, left, right, contentW);

          const tbl = this._extractTableBlock(section.content);
          if (tbl) {
            // Prose around tables: 1.15 spacing, no first-line indent.
            if (tbl.before) this._pdfNarrative(doc, tbl.before, false);
            const weights = tbl.headers.length === 2 ? [3, 2] : undefined;
            this._pdfTable(doc, tbl.headers, tbl.rows, report, weights);
            if (tbl.after) this._pdfNarrative(doc, tbl.after, false);
          } else {
            // Narrative sections: 1.15 spacing + first-line paragraph indent.
            // Identifying Information is a labelled list, so it is not indented.
            const indent = section.section_key !== 'identifying_information';
            this._pdfNarrative(doc, section.content || '(No content)', indent);
          }
          doc.y += 6;
        }

        // ── Assessment Tools / Procedure (dynamic, data-driven) ──
        // Suppress when assessment_tests covers it via a section [[TESTS_TABLE]]
        const _kitHasStructuredBattery = !!(assessmentData && assessmentData.additional_data &&
          Array.isArray(assessmentData.additional_data.assessment_tests) &&
          assessmentData.additional_data.assessment_tests.length > 0);
        const tools = _kitHasStructuredBattery ? [] : this._collectAssessmentTools(assessmentData);
        if (tools.length) {
          _roman += 1;
          this._pdfAssessmentTools(doc, tools, report, `${this._toRoman(_roman)}. ASSESSMENT TOOLS / PROCEDURE`);
        }

        // ── Signatures (three-column: Prepared / Reviewed / Approved) ──
        // The whole block is ~58pt tall. Reserve that space up-front so it can
        // never split across a page break, and render every column with the
        // SAME fixed y-offsets so the layout is byte-for-byte identical no
        // matter which names are present — this keeps the signature panel
        // aligned for every viewer and after the file is passed between staff.
        // Signature labels + names use 12pt Cambria in black; role captions sit
        // just beneath at 9pt and may wrap to a second line. Fixed y-offsets keep
        // all three columns byte-for-byte aligned regardless of which names exist.
        const SIG_BLOCK_HEIGHT = 92;
        if (doc.y + SIG_BLOCK_HEIGHT > bottomLimit) { doc.addPage(); this._pdfPageHeader(doc, report); }
        const sY = doc.y + 6;
        doc.moveTo(left, sY).lineTo(right, sY).strokeColor(COLORS.accent).lineWidth(1).stroke();
        const sigY = sY + 12;
        const _colW = contentW / 3;            // three equal columns within the content width
        const col = [left, left + _colW, left + 2 * _colW]; // x-start of each column
        const colEnd = [col[0] + _colW - 12, col[1] + _colW - 12, right];
        // Names render on a single line (no wrapping) so all three columns keep
        // identical heights and the role captions never overlap a wrapped name.
        const nameOpts = (i) => ({ width: colEnd[i] - col[i], lineBreak: false, ellipsis: true });
        const roleOpts = (i) => ({ width: colEnd[i] - col[i] });
        const LABEL_PT = 12, NAME_PT = 12, ROLE_PT = 9;
        const LINE_Y = 32, NAME_Y = 36, ROLE_Y = 53;

        // When a single Psychologist prepared, reviewed AND approved the report
        // (solo flow — all three names identical), combine them into ONE signatory
        // line instead of three separate columns.
        const _pName = report.prepared_by_name || '';
        const _soloPsych = _pName && _pName === (report.reviewed_by_name || '') && _pName === (report.approved_by_name || '');
        if (_soloPsych) {
          const lineW = contentW;
          doc.fontSize(LABEL_PT).fillColor('#000000').font(FONT_REGULAR).text('Prepared, Reviewed & Approved By:', left, sigY);
          doc.moveTo(left, sigY + LINE_Y).lineTo(left + 240, sigY + LINE_Y).strokeColor('#000000').lineWidth(0.5).stroke();
          doc.fontSize(NAME_PT).fillColor('#000000').font(FONT_BOLD).text(_pName, left, sigY + NAME_Y, { width: lineW, lineBreak: false, ellipsis: true });
          doc.fontSize(ROLE_PT).fillColor('#000000').font(FONT_REGULAR).text('Psychologist', left, sigY + ROLE_Y, { width: lineW });
        } else {
          doc.fontSize(LABEL_PT).fillColor('#000000').font(FONT_REGULAR).text('Prepared By:', col[0], sigY);
          doc.moveTo(col[0], sigY + LINE_Y).lineTo(colEnd[0], sigY + LINE_Y).strokeColor('#000000').lineWidth(0.5).stroke();
          doc.fontSize(NAME_PT).fillColor('#000000').font(FONT_BOLD).text(report.prepared_by_name || '___________________', col[0], sigY + NAME_Y, nameOpts(0));
          doc.fontSize(ROLE_PT).fillColor('#000000').font(FONT_REGULAR).text('Supervising Psychometrician', col[0], sigY + ROLE_Y, roleOpts(0));

          doc.fontSize(LABEL_PT).fillColor('#000000').font(FONT_REGULAR).text('Reviewed By:', col[1], sigY);
          doc.moveTo(col[1], sigY + LINE_Y).lineTo(colEnd[1], sigY + LINE_Y).strokeColor('#000000').lineWidth(0.5).stroke();
          doc.fontSize(NAME_PT).fillColor('#000000').font(FONT_BOLD).text(report.reviewed_by_name || '___________________', col[1], sigY + NAME_Y, nameOpts(1));
          doc.fontSize(ROLE_PT).fillColor('#000000').font(FONT_REGULAR).text('Quality Control Psychometrician', col[1], sigY + ROLE_Y, roleOpts(1));

          doc.fontSize(LABEL_PT).fillColor('#000000').font(FONT_REGULAR).text('Approved By:', col[2], sigY);
          doc.moveTo(col[2], sigY + LINE_Y).lineTo(colEnd[2], sigY + LINE_Y).strokeColor('#000000').lineWidth(0.5).stroke();
          doc.fontSize(NAME_PT).fillColor('#000000').font(FONT_BOLD).text(report.approved_by_name || '___________________', col[2], sigY + NAME_Y, nameOpts(2));
          doc.fontSize(ROLE_PT).fillColor('#000000').font(FONT_REGULAR).text('Psychologist', col[2], sigY + ROLE_Y, roleOpts(2));
        }
        doc.y = sigY + 72;

        // ── Mental Health Certificate (separate final page, opt-in only) ──
        if (options.includeCertificate) {
          this._pdfCertificatePage(doc, report, approvals, options);
        }

        // ── Watermark + Footer on all pages ──
        const pages = doc.bufferedPageRange();
        for (let i = 0; i < pages.count; i++) {
          doc.switchToPage(pages.start + i);

          // Neutralize page margins for this pass. The watermark and footer are
          // drawn at absolute positions near the page edges; with the normal
          // bottom margin in place, PDFKit treats those y-positions as overflow
          // and auto-inserts a blank page before drawing — which was appending
          // several blank trailing pages to every report. Restored below.
          const savedMargins = doc.page.margins;
          doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

          // Watermark — diagonal, centred, and scaled so the whole word always
          // fits on the page (never clipped). The font size is reduced until the
          // rotated text projects within the page width, then it is drawn
          // measured-centred (no width box) so it cannot be cut off.
          const WM_SPACING = 8;
          let wmSize = 100;
          doc.font(FONT_BOLD).fontSize(wmSize);
          let wmWidth = doc.widthOfString('CONFIDENTIAL', { characterSpacing: WM_SPACING });
          const maxProjected = doc.page.width * 0.9;   // keep within 90% of page width
          while (wmWidth / Math.SQRT2 > maxProjected && wmSize > 30) {
            wmSize -= 2;
            doc.fontSize(wmSize);
            wmWidth = doc.widthOfString('CONFIDENTIAL', { characterSpacing: WM_SPACING });
          }
          doc.save();
          doc.translate(doc.page.width / 2, doc.page.height / 2);
          doc.rotate(-45);
          doc.fillColor(COLORS.accent).opacity(0.07).fontSize(wmSize)
             .text('CONFIDENTIAL', -wmWidth / 2, -wmSize / 2, { lineBreak: false, characterSpacing: WM_SPACING });
          doc.opacity(1);
          doc.restore();

          // Footer (inside the 1-inch bottom margin band)
          const bottom = doc.page.height - 30;
          doc.fontSize(6).fillColor('#000000').font(FONT_REGULAR);
          doc.text('CONFIDENTIAL — This report is confidential and intended solely for the use of the individual or entity to which it is addressed.',
            MARGIN, bottom - 8, { width: doc.page.width - 2 * MARGIN, align: 'center', lineBreak: false });
          doc.text(`Page ${i + 1} of ${pages.count}`, MARGIN, bottom, { width: doc.page.width - 2 * MARGIN, align: 'center', lineBreak: false });

          doc.page.margins = savedMargins;
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  },

  // Running header for continuation pages. It sits inside the 1-inch top margin;
  // body content resumes at the 1-inch margin so every page keeps the same top.
  _pdfPageHeader(doc, report) {
    doc.fontSize(7).fillColor(COLORS.muted)
       .text(`Barcarse Psychological Services — ${report.client_name}`, MARGIN, 40, { lineBreak: false });
    doc.moveTo(MARGIN, 52).lineTo(doc.page.width - MARGIN, 52).strokeColor(COLORS.border).stroke();
    doc.y = MARGIN;
    doc.fillColor(COLORS.dark);
  },

  // Standard section heading: a gold rule, then a 13pt bold UPPERCASE,
  // left-aligned title. Used by every body section so spacing is identical.
  _pdfSectionHeading(doc, label, left, right, contentW) {
    doc.y += 8; // consistent space before the heading
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(COLORS.accent).lineWidth(1).stroke();
    doc.fontSize(HEADING_FONT_PT).fillColor(COLORS.primary).font(FONT_BOLD)
       .text(label, left, doc.y + 5, { width: contentW, align: 'left' });
    doc.y += 6; // consistent space after the heading, before the body
  },

  // ─── PDFKit: Letterhead (logo + clinic name, matching the printed letterhead) ──
  _pdfLetterhead(doc) {
    const left = MARGIN;
    const right = doc.page.width - MARGIN;

    let textX = left;
    if (fs.existsSync(LOGO_PATH)) {
      try {
        doc.image(LOGO_PATH, left, 18, { width: 74, height: 74 });
        textX = left + 88;
      } catch (e) { textX = left; }
    }

    doc.fillColor(COLORS.dark).font(FONT_BOLD).fontSize(21)
       .text('Barcarse Psychological Services', textX, 22, { width: right - textX });

    // Rule beneath the clinic name
    doc.moveTo(textX, 50).lineTo(right, 50).strokeColor(COLORS.dark).lineWidth(1).stroke();

    doc.font(FONT_REGULAR).fontSize(11).fillColor(COLORS.dark)
       .text('Psychological Clinic Services', textX, 55, { width: right - textX });
    doc.font(FONT_BOLD).fontSize(11).fillColor(COLORS.dark)
       .text('Psychological Assessment Section', textX, 69, { width: right - textX });
    doc.font(FONT_ITALIC).fontSize(9.5).fillColor(COLORS.dark)
       .text('Sampaloc, Manila, Philippines', textX, 83, { width: right - textX });

    // Gold accent line across the content width (within the 1-inch margins)
    doc.rect(left, 101, right - left, 3).fill(COLORS.accent);

    doc.font(FONT_REGULAR).fillColor(COLORS.dark);
    doc.y = 110;
  },

  // ─── PDFKit: Assessment Tools table ──────────────────────────
  _pdfAssessmentTools(doc, tools, report, heading) {
    const left = MARGIN;
    const right = doc.page.width - MARGIN;
    const contentW = right - left;
    const pad = 4;
    const fontSize = BODY_FONT_PT;   // 12pt — matches report body text
    const bottomLimit = doc.page.height - MARGIN;

    const active = this._activeToolColumns(tools);
    const defs = [{ key: 'name', label: 'Assessment Tool / Test', w: 3, align: 'left' }];
    if (active.category)   defs.push({ key: 'category',   label: 'Category',       w: 2,   align: 'left' });
    if (active.raw)        defs.push({ key: 'raw',        label: 'Raw',            w: 1,   align: 'center' });
    if (active.standard)   defs.push({ key: 'standard',   label: 'Standard',       w: 1.2, align: 'center' });
    if (active.scaled)     defs.push({ key: 'scaled',     label: 'Scaled',         w: 1.2, align: 'center' });
    if (active.percentile) defs.push({ key: 'percentile', label: '%ile',           w: 1,   align: 'center' });
    if (active.range)      defs.push({ key: 'range',      label: 'Desc. Range',    w: 2.2, align: 'left' });
    if (active.notes)      defs.push({ key: 'notes',      label: 'Interpretation', w: 3,   align: 'left' });

    const totalW = defs.reduce((s, d) => s + d.w, 0);
    let x = left;
    defs.forEach((d) => { d.width = contentW * (d.w / totalW); d.x = x; x += d.width; });

    const valFor = (t, key) => (this._hasVal(t[key]) ? String(t[key]) : '—');

    // Draw column separators + outer border for a row band (visible cell borders).
    const drawCellBorders = (y, h) => {
      doc.lineWidth(0.5).strokeColor(COLORS.border);
      doc.rect(left, y, contentW, h).stroke();
      defs.forEach((d, i) => { if (i > 0) doc.moveTo(d.x, y).lineTo(d.x, y + h).stroke(); });
    };

    // Section header (numbered, consistent with the body sections)
    if (doc.y > bottomLimit - 60) { doc.addPage(); this._pdfPageHeader(doc, report); }
    this._pdfSectionHeading(doc, heading || 'ASSESSMENT TOOLS / PROCEDURE', left, right, contentW);

    const drawHeaderRow = () => {
      const hY = doc.y;
      doc.font(FONT_BOLD).fontSize(fontSize);
      let hH = 0;
      defs.forEach((d) => { hH = Math.max(hH, doc.heightOfString(d.label, { width: d.width - pad * 2 })); });
      hH += pad * 2;
      doc.rect(left, hY, contentW, hH).fill(COLORS.primary);
      // Header labels are centred and clearly distinguished from the body.
      doc.fillColor('#ffffff').font(FONT_BOLD).fontSize(fontSize);
      defs.forEach((d) => { doc.text(d.label, d.x + pad, hY + pad, { width: d.width - pad * 2, align: 'center' }); });
      drawCellBorders(hY, hH);
      doc.y = hY + hH;
    };

    drawHeaderRow();

    let zebra = false;
    tools.forEach((t) => {
      // Measure tallest cell for this row
      let rH = 0;
      defs.forEach((d) => {
        const txt = d.key === 'name' ? t.name : valFor(t, d.key);
        doc.font(d.key === 'name' ? FONT_BOLD : FONT_REGULAR).fontSize(fontSize);
        rH = Math.max(rH, doc.heightOfString(txt || '—', { width: d.width - pad * 2 }));
      });
      rH += pad * 2;

      if (doc.y + rH > bottomLimit) {
        doc.addPage();
        this._pdfPageHeader(doc, report);
        drawHeaderRow();
      }

      const rY = doc.y;
      if (zebra) doc.rect(left, rY, contentW, rH).fill(COLORS.bgLight);
      zebra = !zebra;

      // Cell content: black, centred horizontally and vertically within the cell.
      defs.forEach((d) => {
        const isName = d.key === 'name';
        const txt = (isName ? t.name : valFor(t, d.key)) || '—';
        doc.font(isName ? FONT_BOLD : FONT_REGULAR).fontSize(fontSize).fillColor('#000000');
        const cellH = doc.heightOfString(txt, { width: d.width - pad * 2, align: 'center' });
        const ty = rY + Math.max(pad, (rH - cellH) / 2);
        doc.text(txt, d.x + pad, ty, { width: d.width - pad * 2, align: 'center' });
      });
      drawCellBorders(rY, rH);
      doc.y = rY + rH;
    });

    doc.y += 6;
  },

  // ─── PDFKit: Mental Health Certificate page ──────────────────
  _pdfCertificatePage(doc, report, approvals, options = {}) {
    doc.addPage();
    this._pdfLetterhead(doc);

    doc.font(FONT_BOLD).fontSize(HEADING_FONT_PT).fillColor(COLORS.primary)
       .text('MENTAL HEALTH CERTIFICATE', MARGIN, doc.y, { align: 'center', width: doc.page.width - 2 * MARGIN, characterSpacing: 1.5 });
    doc.y += 16;
    doc.fillColor(COLORS.dark);

    const left = MARGIN;
    const contentW = doc.page.width - 2 * MARGIN;
    const assessDate = report.date_of_assessment
      ? new Date(report.date_of_assessment).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'N/A';
    const dateIssued = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const clientName   = report.client_name || '';
    const address      = options.certAddress    || '';
    const purpose      = options.certPurpose    || '(purpose not specified)';
    const impression   = this._capitalizeSentences(options.certImpression || '') || '(psychological impression not specified)';
    const validity     = options.certValidity   || '(validity not specified)';
    const licenseNo    = options.certLicenseNo  || '';
    const ptrNo        = options.certPtrNo      || '';
    const licValid     = options.certLicenseValidity || '';
    const approvedName = report.approved_by_name || '';

    const para = (text, opts = {}) => {
      doc.font(FONT_REGULAR).fontSize(BODY_FONT_PT).fillColor('#000000')
         .text(text, left, doc.y, { width: contentW, align: 'justify', lineGap: BODY_LINE_GAP, ...opts });
      doc.y += 10;
    };

    // "TO WHOM IT MAY CONCERN:"
    doc.font(FONT_BOLD).fontSize(BODY_FONT_PT).fillColor('#000000')
       .text('TO WHOM IT MAY CONCERN:', left, doc.y, { width: contentW });
    doc.y += 14;

    // Certification body
    const addressPart = address ? `, of ${address},` : '';
    para(`This is to certify that ${clientName}${addressPart} was examined and evaluated at Barcarse Psychological Services, Sampaloc, Manila, Philippines.`);

    para(`Based on the results of the psychological evaluation conducted on ${assessDate}, the psychological impression noted is as follows:`);

    // ── Psychological Impression / Diagnosis box (dynamic height) ──
    // The box grows with the statement: its height is the measured wrapped text
    // height plus uniform padding — no fixed height. Border/padding stay constant
    // at any height, text wraps and multiple paragraphs are accommodated, and the
    // following content is pushed below the box so it can never overlap.
    const IMP_PAD = 10;                   // uniform inner padding (top & bottom)
    const IMP_MIN_H = 64;                 // minimum height so short text has room to centre
    const IMP_TEXT_W = contentW - 24;     // 12pt inset on each side (constant)
    // Measure with the SAME font/size used to render, so the computed height
    // matches the wrapped text exactly (bold-italic is wider than the regular
    // body font — measuring with the wrong font under-counted lines and clipped).
    doc.font(FONT_BOLD_ITALIC).fontSize(BODY_FONT_PT);
    const impTextH = doc.heightOfString(impression, { width: IMP_TEXT_W, align: 'center' });
    const impH = Math.max(impTextH + IMP_PAD * 2, IMP_MIN_H);
    // If the (possibly tall) box would run past the bottom margin, start a fresh
    // page first so it is never clipped at the page edge.
    if (doc.y + impH > doc.page.height - MARGIN) { doc.addPage(); doc.y = MARGIN; }
    const impY = doc.y;
    doc.rect(left, impY, contentW, impH)
       .lineWidth(0.5).strokeColor(COLORS.border).fillColor(COLORS.bgLight).fillAndStroke();
    // Text is centred horizontally (align) and vertically centred within whatever
    // extra space the box has (the box may be taller than the text via IMP_MIN_H).
    const impTextY = impY + Math.max(IMP_PAD, (impH - impTextH) / 2);
    doc.font(FONT_BOLD_ITALIC).fontSize(BODY_FONT_PT).fillColor('#000000')
       .text(impression, left + 12, impTextY, { width: IMP_TEXT_W, align: 'center' });
    doc.y = impY + impH + 12;

    para(`This certificate is issued upon the request of ${clientName} for ${purpose} purposes only, and is valid until ${validity}.`);

    doc.font(FONT_REGULAR).fontSize(BODY_FONT_PT).fillColor('#000000')
       .text(`Date Issued: `, left, doc.y, { continued: true })
       .font(FONT_BOLD).text(dateIssued);
    doc.y += 24;

    // Signature block
    doc.moveTo(left, doc.y).lineTo(left + contentW, doc.y).strokeColor(COLORS.accent).lineWidth(1).stroke();
    doc.y += 28;

    const sigLineEnd = left + 240;
    doc.moveTo(left, doc.y).lineTo(sigLineEnd, doc.y).strokeColor(COLORS.dark).lineWidth(0.5).stroke();
    doc.y += 4;

    // Signatory credentials use the 12pt body font size for consistency with the
    // report body (line spacing bumped to fit the larger text; layout preserved).
    if (approvedName) {
      doc.font(FONT_BOLD).fontSize(BODY_FONT_PT).fillColor('#000000').text(approvedName, left, doc.y, { width: 320 });
      doc.y += 16;
    }
    doc.font(FONT_REGULAR).fontSize(BODY_FONT_PT).fillColor('#000000');
    doc.text('Licensed Psychologist', left, doc.y, { width: 380 }); doc.y += 15;
    doc.text('Barcarse Psychological Services – Psychological Assessment Section', left, doc.y, { width: 420 }); doc.y += 15;
    doc.text(`Psychologist License No.: ${licenseNo}`, left, doc.y); doc.y += 15;
    doc.text(`License Valid Until: ${licValid}`, left, doc.y); doc.y += 15;
    doc.text(`PTR No.: ${ptrNo}`, left, doc.y);
  },

  _esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // ─── Assessment Tools helpers ────────────────────────────────
  // True only when a value is genuinely present (not null/blank).
  _hasVal(v) {
    return v !== null && v !== undefined && String(v).trim() !== '';
  },

  // Detect a fenced table block in a section's content, e.g.
  //   [[FINDINGS_TABLE]] header... rows... [[/FINDINGS_TABLE]]
  // Columns are separated by '||'. Returns { headers, rows, before, after } or null.
  // Renders narrative content as separated <p> paragraphs (split on blank lines)
  // for clean paragraph separation. When `indent` is true each paragraph receives
  // a first-line indent via the `.narrative` modifier; single-newline lines inside
  // a paragraph are preserved as <br> (e.g. the Identifying Information list).
  _paragraphsHtml(content, indent) {
    const paras = String(this._capitalizeSentences(content) || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const cls = `section-content${indent ? ' narrative' : ''}`;
    if (!paras.length) return `<div class="${cls}"><p>(No content)</p></div>`;
    const inner = paras.map(p => `<p>${this._esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    return `<div class="${cls}">${inner}</div>`;
  },

  // PDFKit equivalent of _paragraphsHtml: renders justified body text at 12pt
  // with ~1.15 line spacing (lineGap) and clean paragraph separation. When
  // `indent` is true, each paragraph's first line is indented. Used for all
  // narrative report sections so the PDFKit fallback matches the HTML output.
  _pdfNarrative(doc, content, indent) {
    const PARA_GAP = 4;   // vertical gap between paragraphs
    const x = MARGIN;
    const width = doc.page.width - 2 * MARGIN;
    doc.font(FONT_REGULAR).fontSize(BODY_FONT_PT).fillColor('#000000');
    const paras = String(this._capitalizeSentences(content) || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    if (!paras.length) {
      doc.text('(No content)', x, doc.y, { width, align: 'justify', lineGap: BODY_LINE_GAP });
      return;
    }
    paras.forEach((p, i) => {
      doc.text(p, x, doc.y, { width, align: 'justify', lineGap: BODY_LINE_GAP, indent: indent ? PARA_INDENT : 0 });
      if (i < paras.length - 1) doc.y += PARA_GAP;
    });
  },

  // Normalize sentence capitalization for narrative text WITHOUT altering wording.
  // It only ever UPPERCASES a sentence-initial letter that is lowercase; it never
  // lowercases anything, so existing proper capitalization (names, places,
  // organizations, tests, diagnoses, titles) and acronyms / clinical terms
  // (BPS, ADHD, ASD, WAIS-IV, DSM-5-TR, …) are preserved exactly as written.
  _capitalizeSentences(content) {
    if (content === null || content === undefined) return content;
    let text = String(content);

    // Abbreviations that end with a period but usually do NOT end a sentence —
    // the following word must not be capitalized after these.
    const ABBR = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'al', 'viz', 'resp', 'no', 'fig']);
    const precededByAbbr = (str, periodIdx) => {
      const before = str.slice(0, periodIdx);
      const m = before.match(/([A-Za-z][A-Za-z.]*)$/);
      if (!m) return false;
      const tok = m[1].replace(/\.+$/, '').toLowerCase();
      return ABBR.has(tok);
    };

    // 1) Capitalize the first letter after a sentence terminator (. ! ?),
    //    allowing an optional closing quote/bracket, then whitespace.
    text = text.replace(/([.!?]["'”’)\]]?\s+)([a-z])/g, (match, sep, ch, offset) =>
      precededByAbbr(text, offset) ? match : sep + ch.toUpperCase());

    // 2) Capitalize the first letter at the start of the text and each new line.
    text = text.replace(/(^|\n)([ \t>"'(\[]*)([a-z])/g, (m, br, lead, ch) =>
      br + lead + ch.toUpperCase());

    return text;
  },

  // Convert a positive integer to a Roman numeral (1 → I, 4 → IV, 9 → IX, …).
  // Used to number section titles at render time without altering stored data.
  _toRoman(num) {
    const map = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],
                 [50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
    let n = Math.max(0, parseInt(num, 10) || 0);
    let out = '';
    for (const [v, s] of map) { while (n >= v) { out += s; n -= v; } }
    return out;
  },

  _extractTableBlock(content) {
    if (!content) return null;
    const m = String(content).match(/\[\[([A-Z_]+_TABLE)\]\]\s*([\s\S]*?)\s*\[\[\/\1\]\]/);
    if (!m) return null;
    const lines = m[2].split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    const headers = lines[0].split('||').map((s) => s.trim());
    const rows = lines.slice(1).map((l) => l.split('||').map((s) => s.trim()));
    return {
      headers,
      rows,
      before: content.slice(0, m.index).trim(),
      after: content.slice(m.index + m[0].length).trim(),
    };
  },

  // Generic PDFKit table drawer (used for Findings and Tests tables).
  // Spans the full content width, draws visible borders on every cell, centres
  // the header row, and repeats the header after a page break.
  _pdfTable(doc, headers, rows, report, weights) {
    const left = MARGIN;
    const right = doc.page.width - MARGIN;
    const contentW = right - left;
    const pad = 4;
    const fontSize = BODY_FONT_PT;   // 12pt — matches report body text
    const bottomLimit = doc.page.height - MARGIN;

    const w = (weights && weights.length === headers.length)
      ? weights.slice()
      : headers.map((_, i) => (i === 0 ? 1.8 : 1));
    const totalW = w.reduce((s, n) => s + n, 0);
    const defs = headers.map((h, i) => ({ label: h, w: w[i] }));
    let x = left;
    defs.forEach((d) => { d.width = contentW * (d.w / totalW); d.x = x; x += d.width; });

    // Column separators + outer border for a row band (visible cell borders).
    const drawCellBorders = (y, h) => {
      doc.lineWidth(0.5).strokeColor(COLORS.border);
      doc.rect(left, y, contentW, h).stroke();
      defs.forEach((d, i) => { if (i > 0) doc.moveTo(d.x, y).lineTo(d.x, y + h).stroke(); });
    };

    const drawHeaderRow = () => {
      const hY = doc.y;
      doc.font(FONT_BOLD).fontSize(fontSize);
      let hH = 0;
      defs.forEach((d) => { hH = Math.max(hH, doc.heightOfString(d.label, { width: d.width - pad * 2 })); });
      hH += pad * 2;
      doc.rect(left, hY, contentW, hH).fill(COLORS.primary);
      doc.fillColor('#ffffff').font(FONT_BOLD).fontSize(fontSize);
      defs.forEach((d) => { doc.text(d.label, d.x + pad, hY + pad, { width: d.width - pad * 2, align: 'center' }); });
      drawCellBorders(hY, hH);
      doc.y = hY + hH;
    };

    if (doc.y > bottomLimit - 40) { doc.addPage(); this._pdfPageHeader(doc, report); }
    drawHeaderRow();

    let zebra = false;
    rows.forEach((row) => {
      let rH = 0;
      defs.forEach((d, ci) => {
        doc.font(ci === 0 ? FONT_BOLD : FONT_REGULAR).fontSize(fontSize);
        rH = Math.max(rH, doc.heightOfString(row[ci] || '—', { width: d.width - pad * 2 }));
      });
      rH += pad * 2;

      if (doc.y + rH > bottomLimit) {
        doc.addPage(); this._pdfPageHeader(doc, report); drawHeaderRow();
      }
      const rY = doc.y;
      if (zebra) doc.rect(left, rY, contentW, rH).fill(COLORS.bgLight);
      zebra = !zebra;
      // Cell content: black, centred horizontally and vertically within the cell.
      defs.forEach((d, ci) => {
        const txt = row[ci] || '—';
        doc.font(ci === 0 ? FONT_BOLD : FONT_REGULAR).fontSize(fontSize).fillColor('#000000');
        const cellH = doc.heightOfString(txt, { width: d.width - pad * 2, align: 'center' });
        const ty = rY + Math.max(pad, (rH - cellH) / 2);
        doc.text(txt, d.x + pad, ty, { width: d.width - pad * 2, align: 'center' });
      });
      drawCellBorders(rY, rH);
      doc.y = rY + rH;
    });
    doc.y += 6;
  },

  /**
   * Build the list of assessment tools to display, from the data the staff
   * actually entered. Only administered instruments are included; empty /
   * unadministered tools are excluded entirely.
   *   - tests_administered → administered instruments
   */
  _collectAssessmentTools(assessmentData) {
    const tools = [];
    const seen = new Set();

    const administered = (assessmentData && assessmentData.tests_administered) || [];
    administered.forEach((name) => {
      if (!this._hasVal(name)) return;
      const key = String(name).trim().toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      tools.push({
        name: String(name).trim(),
        category: '', raw: null, percentile: null,
        standard: null, scaled: null, range: '', notes: '',
      });
    });

    return tools;
  },

  // Decide which optional columns to render — only those with at least one value.
  _activeToolColumns(tools) {
    return {
      category:   tools.some((t) => this._hasVal(t.category)),
      raw:        tools.some((t) => this._hasVal(t.raw)),
      percentile: tools.some((t) => this._hasVal(t.percentile)),
      standard:   tools.some((t) => this._hasVal(t.standard)),
      scaled:     tools.some((t) => this._hasVal(t.scaled)),
      range:      tools.some((t) => this._hasVal(t.range)),
      notes:      tools.some((t) => this._hasVal(t.notes)),
    };
  },

  /**
   * Staff who participated in administering / handling the assessment:
   * the examining psychologist plus any reviewers who acted on the report.
   */
  _participatingStaff(report, approvals) {
    const staff = [];
    const seen = new Set();
    const add = (name, role) => {
      if (!this._hasVal(name)) return;
      const key = String(name).trim().toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      staff.push({ name: String(name).trim(), role });
    };

    add(report.prepared_by_name, 'Supervising Psychometrician');
    add(report.reviewed_by_name, 'Quality Control Psychometrician');
    add(report.approved_by_name, 'Psychologist');
    // Fallback: if new signatory columns are empty, use legacy fields
    if (!staff.length) {
      add(report.psychologist_name, 'Examining Psychologist');
      (approvals || []).forEach((a) => {
        add(a.reviewer_name, a.decision === 'approved' ? 'Clinical Director (Approved)' : 'Reviewer');
      });
    }
    return staff;
  },
};

module.exports = PdfGenerator;
