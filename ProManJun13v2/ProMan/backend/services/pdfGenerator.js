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

const PdfGenerator = {
  async generate(report, sections, assessmentData, approvals) {
    const html = this._buildHtml(report, sections, assessmentData, approvals);

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
            paper_size: 'Letter',
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

    return this._generateWithPdfKit(report, sections, assessmentData, approvals);
  },

  // ─── HTML Builder ────────────────────────────────────────────
  _buildHtml(report, sections, assessmentData, approvals) {
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

    const sectionsHtml = sections
      .filter(s => s.content || s.section_key === 'identifying_information')
      .map(s => {
        const tbl = this._extractTableBlock(s.content);
        let body;
        if (tbl) {
          const thead = `<tr>${tbl.headers.map(h => `<th>${this._esc(h)}</th>`).join('')}</tr>`;
          const tbody = tbl.rows.map(r => `<tr>${r.map(c => `<td>${this._esc(c)}</td>`).join('')}</tr>`).join('');
          const beforeHtml = tbl.before ? `<div class="section-content">${this._esc(tbl.before).replace(/\n/g, '<br>')}</div>` : '';
          const afterHtml = tbl.after ? `<div class="section-content">${this._esc(tbl.after).replace(/\n/g, '<br>')}</div>` : '';
          body = `${beforeHtml}<table class="tools-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>${afterHtml}`;
        } else {
          body = `<div class="section-content">${this._esc(s.content || '(No content)').replace(/\n/g, '<br>')}</div>`;
        }
        return `<div class="section"><h2>${this._esc(s.section_title)}</h2>${body}</div>`;
      }).join('');

    // ── Assessment Tools / Procedure (dynamic, data-driven) ──
    const tools = this._collectAssessmentTools(assessmentData);
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

      toolsHtml = `
        <div class="section">
          <h2>Assessment Tools / Procedure</h2>
          <table class="tools-table">
            <thead><tr>${headCells.join('')}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    // ── Mental Health Certificate (separate final page) ──
    const staff = this._participatingStaff(report, approvals);
    const staffRows = staff.length
      ? staff.map((s) => `
          <div class="cert-staff-block">
            <div class="cert-sig-line"></div>
            <div class="cert-sig-name">${this._esc(s.name)}</div>
            <div class="cert-sig-role">${this._esc(s.role)}</div>
          </div>`).join('')
      : '<div class="cert-staff-empty">No participating staff recorded.</div>';

    const certificateHtml = `
      <div class="certificate-page">
        ${letterhead}
        <div class="cert-title">Mental Health Certificate</div>
        <div class="content">
          <div class="client-info">
            <h3>Patient Information</h3>
            <div class="client-grid">
              <div class="client-field"><strong>Full Name:</strong> ${this._esc(report.client_name || 'N/A')}</div>
              <div class="client-field"><strong>Age:</strong> ${report.client_age ? report.client_age + ' years old' : 'N/A'}</div>
              <div class="client-field"><strong>Gender:</strong> ${this._esc(report.client_gender || 'N/A')}</div>
              <div class="client-field"><strong>Date of Assessment:</strong> ${assessDate}</div>
            </div>
          </div>

          <div class="section">
            <h2>Participating Staff</h2>
            <p class="cert-intro">This certifies that the psychological assessment of the above-named patient was administered and handled by the following staff member(s):</p>
            <div class="cert-staff-grid">${staffRows}</div>
          </div>

          <div class="pdf-footer">
            CONFIDENTIAL — This certificate is confidential and intended solely for the use of the individual or entity to which it is addressed.
          </div>
        </div>
      </div>`;



    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', Arial, sans-serif; font-size: 11px; color: #475467; line-height: 1.6; }

  /* Watermark on every page */
  @media print {
    body::after { content: 'CONFIDENTIAL'; position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-45deg); font-size: 120px; font-weight: 900; color: rgba(30,58,138,0.06); letter-spacing: 16px; pointer-events: none; z-index: 0; white-space: nowrap; }
  }
  .watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-45deg); font-size: 120px; font-weight: 900; color: rgba(30,58,138,0.06); letter-spacing: 16px; pointer-events: none; z-index: 0; white-space: nowrap; }

  /* Letterhead — matches the printed clinic letterhead */
  .letterhead { display: flex; align-items: center; gap: 18px; padding: 20px 30px 12px; }
  .lh-logo { width: 88px; height: 88px; border-radius: 50%; flex: 0 0 auto; object-fit: cover; }
  .lh-text { flex: 1; font-family: Georgia, 'Times New Roman', Times, serif; color: #1B2230; }
  .lh-org { font-size: 25px; font-weight: 700; line-height: 1.05; }
  .lh-rule { border-bottom: 1.5px solid #1B2230; margin: 5px 0 6px; }
  .lh-line { font-size: 14px; line-height: 1.35; color: #1B2230; }
  .lh-line.bold { font-weight: 700; }
  .lh-loc { font-size: 12.5px; font-style: italic; margin-top: 3px; color: #1B2230; }
  .lh-accent { height: 3px; background: #C0922E; }

  /* Document title block (below header, before client information) */
  .report-title-block { text-align: center; padding: 14px 30px 6px; }
  .report-title { font-size: 15px; font-weight: 700; color: #1E3A8A; letter-spacing: 2px; text-transform: uppercase; }
  .report-type { display: inline-block; margin-top: 6px; font-size: 9.5px; font-weight: 600; color: #8A6A18; letter-spacing: 1.5px; text-transform: uppercase; border-top: 1px solid #E4E7EC; padding-top: 5px; }
  .cert-title { text-align: center; padding: 14px 30px 6px; font-size: 16px; font-weight: 700; color: #1E3A8A; letter-spacing: 2px; text-transform: uppercase; }

  .content { padding: 16px 30px; position: relative; z-index: 1; }

  .client-info { border: 1px solid #E4E7EC; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; background: #F8FAFC; }
  .client-info h3 { font-size: 11px; color: #1E3A8A; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; font-weight: 700; border-bottom: 1px solid #E4E7EC; padding-bottom: 4px; }
  .client-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; }
  .client-field { font-size: 10px; }
  .client-field strong { color: #1B2230; font-weight: 600; }

  .section { margin-bottom: 12px; page-break-inside: avoid; }
  .section h2 { font-size: 12px; color: #1E3A8A; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 700; padding-bottom: 4px; border-bottom: 2px solid #C0922E; margin-bottom: 6px; }
  .section-content { font-size: 10.5px; color: #475467; line-height: 1.65; text-align: justify; }



  .signatures { display: flex; justify-content: space-between; margin-top: 24px; padding-top: 12px; border-top: 2px solid #C0922E; page-break-inside: avoid; }
  .sig-block { width: 45%; }
  .sig-label { font-size: 9px; color: #98A2B3; margin-bottom: 24px; }
  .sig-line { border-bottom: 1px solid #1B2230; margin-bottom: 6px; }
  .sig-name { font-size: 11px; font-weight: 700; color: #1B2230; }
  .sig-title { font-size: 8px; color: #98A2B3; }

  .pdf-footer { text-align: center; font-size: 7px; color: #98A2B3; margin-top: 16px; padding-top: 6px; border-top: 1px solid #E4E7EC; }

  /* Assessment Tools table */
  .tools-table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 9.5px; }
  .tools-table th { background: #1E3A8A; color: #ffffff; text-align: left; padding: 6px 8px; font-weight: 600; font-size: 9px; letter-spacing: 0.3px; }
  .tools-table td { padding: 5px 8px; border-bottom: 1px solid #E4E7EC; color: #475467; vertical-align: top; }
  .tools-table tbody tr:nth-child(even) { background: #F8FAFC; }
  .tools-table .tool-name-col { width: 26%; }
  .tools-table .tool-name-col strong { color: #1B2230; font-weight: 600; }
  .tools-table .tool-notes-col { color: #475467; }

  /* Mental Health Certificate page */
  .certificate-page { page-break-before: always; }
  .cert-intro { font-size: 10.5px; color: #475467; line-height: 1.65; text-align: justify; margin-bottom: 18px; }
  .cert-staff-grid { display: flex; flex-wrap: wrap; gap: 28px 40px; margin-top: 28px; }
  .cert-staff-block { width: 42%; min-width: 220px; }
  .cert-sig-line { border-bottom: 1px solid #1B2230; height: 28px; margin-bottom: 6px; }
  .cert-sig-name { font-size: 11px; font-weight: 700; color: #1B2230; }
  .cert-sig-role { font-size: 8.5px; color: #98A2B3; }
  .cert-staff-empty { font-size: 10px; color: #98A2B3; font-style: italic; }
</style>
</head>
<body>
  <div class="watermark">CONFIDENTIAL</div>

  ${letterhead}

  <div class="report-title-block">
    <div class="report-title">Psychological Assessment Report</div>
    ${templateName ? `<div class="report-type">${this._esc(templateName)}</div>` : ''}
  </div>

  <div class="content">
    <div class="client-info">
      <h3>Client Information</h3>
      <div class="client-grid">
        <div class="client-field"><strong>Full Name:</strong> ${this._esc(report.client_name || 'N/A')}</div>
        <div class="client-field"><strong>Age:</strong> ${report.client_age ? report.client_age + ' years old' : 'N/A'}</div>
        <div class="client-field"><strong>Gender:</strong> ${this._esc(report.client_gender || 'N/A')}</div>
        <div class="client-field"><strong>Date of Assessment:</strong> ${assessDate}</div>
      </div>
    </div>

    ${sectionsHtml}

    ${toolsHtml}

    <div class="signatures">
      <div class="sig-block">
        <div class="sig-label">Prepared By:</div>
        <div class="sig-line"></div>
        <div class="sig-name">${this._esc(report.psychologist_name || '___________________')}</div>
        <div class="sig-title">Licensed Psychologist</div>
      </div>
      <div class="sig-block">
        <div class="sig-label">Approved By:</div>
        <div class="sig-line"></div>
        <div class="sig-name">${approval ? this._esc(approval.reviewer_name) : '___________________'}</div>
        <div class="sig-title">Clinical Director</div>
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
  async _generateWithPdfKit(report, sections, assessmentData, approvals) {
    const PDFDocument = require('pdfkit');

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'LETTER',
          bufferPages: true,
          margins: { top: 30, bottom: 30, left: 30, right: 30 },
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

        // ── Letterhead (matches the printed clinic letterhead) ──
        this._pdfLetterhead(doc);

        // ── Document title + test type (below header, before client info) ──
        doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.primary)
           .text('PSYCHOLOGICAL ASSESSMENT REPORT', 30, doc.y, { align: 'center', width: doc.page.width - 60, characterSpacing: 1.5 });
        const typeName = (report.template_name || report.template_type || '').toUpperCase();
        if (typeName) {
          doc.font('Helvetica').fontSize(8.5).fillColor('#8A6A18')
             .text(typeName, 30, doc.y + 3, { align: 'center', width: doc.page.width - 60, characterSpacing: 1 });
        }
        doc.fillColor(COLORS.dark);
        doc.y += 10;

        // ── Client Info Box (compact) ──
        const cY = doc.y;
        doc.rect(28, cY, doc.page.width - 56, 52)
           .lineWidth(0.5).strokeColor(COLORS.border).fillColor(COLORS.bgLight).fillAndStroke();
        doc.fontSize(8).fillColor(COLORS.primary).font('Helvetica-Bold')
           .text('CLIENT INFORMATION', 38, cY + 5);
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.dark);
        let rowY = cY + 18;
        doc.font('Helvetica-Bold').text('Full Name:', 38, rowY);
        doc.font('Helvetica').text(report.client_name || 'N/A', 100, rowY);
        doc.font('Helvetica-Bold').text('Age:', 310, rowY);
        doc.font('Helvetica').text(report.client_age ? `${report.client_age} years old` : 'N/A', 340, rowY);
        rowY += 14;
        doc.font('Helvetica-Bold').text('Gender:', 38, rowY);
        doc.font('Helvetica').text(report.client_gender || 'N/A', 100, rowY);
        doc.font('Helvetica-Bold').text('Date:', 310, rowY);
        const dateStr = report.date_of_assessment
          ? new Date(report.date_of_assessment).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
          : 'N/A';
        doc.font('Helvetica').text(dateStr, 340, rowY);
        doc.y = cY + 58;

        // ── Sections ──
        for (const section of sections) {
          if (!section.content && section.section_key !== 'identifying_information') continue;
          if (doc.y > 740) { doc.addPage(); this._pdfPageHeader(doc, report); }
          doc.moveTo(30, doc.y).lineTo(doc.page.width - 30, doc.y).strokeColor(COLORS.accent).lineWidth(1).stroke();
          doc.fontSize(9).fillColor(COLORS.primary).font('Helvetica-Bold')
             .text(section.section_title.toUpperCase(), 30, doc.y + 3);
          doc.y += 14;

          const tbl = this._extractTableBlock(section.content);
          if (tbl) {
            if (tbl.before) {
              doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.text)
                 .text(tbl.before, 30, doc.y, { width: doc.page.width - 60, align: 'justify', lineGap: 1 });
              doc.y += 4;
            }
            const weights = tbl.headers.length === 2 ? [3, 2] : undefined;
            this._pdfTable(doc, tbl.headers, tbl.rows, report, weights);
            if (tbl.after) {
              doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.text)
                 .text(tbl.after, 30, doc.y, { width: doc.page.width - 60, align: 'justify', lineGap: 1 });
            }
          } else {
            doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.text);
            doc.text(section.content || '(No content)', 30, doc.y, {
              width: doc.page.width - 60, align: 'justify', lineGap: 1,
            });
          }
          doc.y += 4;
        }

        // ── Assessment Tools / Procedure (dynamic, data-driven) ──
        const tools = this._collectAssessmentTools(assessmentData);
        if (tools.length) {
          this._pdfAssessmentTools(doc, tools, report);
        }

        // ── Signatures (compact) ──
        if (doc.y > 720) { doc.addPage(); this._pdfPageHeader(doc, report); }
        const sY = doc.y + 6;
        doc.moveTo(30, sY).lineTo(doc.page.width - 30, sY).strokeColor(COLORS.accent).lineWidth(1).stroke();
        const sigY = sY + 10;
        doc.fontSize(8).fillColor(COLORS.muted).font('Helvetica').text('Prepared By:', 30, sigY);
        doc.moveTo(30, sigY + 25).lineTo(240, sigY + 25).strokeColor(COLORS.dark).lineWidth(0.5).stroke();
        doc.fontSize(9).fillColor(COLORS.dark).font('Helvetica-Bold').text(report.psychologist_name || '___________________', 30, sigY + 28);
        doc.fontSize(7).fillColor(COLORS.muted).font('Helvetica').text('Licensed Psychologist', 30, sigY + 40);

        const approval = approvals && approvals.find(a => a.decision === 'approved');
        doc.fontSize(8).fillColor(COLORS.muted).font('Helvetica').text('Approved By:', 320, sigY);
        doc.moveTo(320, sigY + 25).lineTo(530, sigY + 25).strokeColor(COLORS.dark).lineWidth(0.5).stroke();
        doc.fontSize(9).fillColor(COLORS.dark).font('Helvetica-Bold').text(approval ? approval.reviewer_name : '___________________', 320, sigY + 28);
        doc.fontSize(7).fillColor(COLORS.muted).font('Helvetica').text('Clinical Director', 320, sigY + 40);
        doc.y = sigY + 50;

        // ── Mental Health Certificate (separate final page) ──
        this._pdfCertificatePage(doc, report, approvals);

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

          // Watermark
          doc.save();
          doc.translate(doc.page.width / 2, doc.page.height / 2);
          doc.rotate(-45);
          doc.fontSize(100).fillColor(COLORS.accent).opacity(0.07)
             .text('CONFIDENTIAL', -320, -50, { align: 'center', width: 640, lineBreak: false });
          doc.opacity(1);
          doc.restore();

          // Footer
          const bottom = doc.page.height - 18;
          doc.fontSize(6).fillColor(COLORS.muted).font('Helvetica');
          doc.text('CONFIDENTIAL — This report is confidential and intended solely for the use of the individual or entity to which it is addressed.',
            30, bottom - 8, { width: doc.page.width - 60, align: 'center', lineBreak: false });
          doc.text(`Page ${i + 1} of ${pages.count}`, 30, bottom, { width: doc.page.width - 60, align: 'center', lineBreak: false });

          doc.page.margins = savedMargins;
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  },

  _pdfPageHeader(doc, report) {
    doc.fontSize(7).fillColor(COLORS.muted)
       .text(`Barcarse Psychological Services — ${report.client_name}`, 30, 14);
    doc.moveTo(30, 24).lineTo(doc.page.width - 30, 24).strokeColor(COLORS.border).stroke();
    doc.y = 30;
    doc.fillColor(COLORS.dark);
  },

  // ─── PDFKit: Letterhead (logo + clinic name, matching the printed letterhead) ──
  _pdfLetterhead(doc) {
    const left = 30;
    const right = doc.page.width - 30;

    let textX = left;
    if (fs.existsSync(LOGO_PATH)) {
      try {
        doc.image(LOGO_PATH, left, 18, { width: 74, height: 74 });
        textX = left + 88;
      } catch (e) { textX = left; }
    }

    doc.fillColor(COLORS.dark).font('Times-Bold').fontSize(21)
       .text('Barcarse Psychological Services', textX, 22, { width: right - textX });

    // Rule beneath the clinic name
    doc.moveTo(textX, 50).lineTo(right, 50).strokeColor(COLORS.dark).lineWidth(1).stroke();

    doc.font('Times-Roman').fontSize(11).fillColor(COLORS.dark)
       .text('Psychological Clinic Services', textX, 55, { width: right - textX });
    doc.font('Times-Bold').fontSize(11).fillColor(COLORS.dark)
       .text('Psychological Assessment Section', textX, 69, { width: right - textX });
    doc.font('Times-Italic').fontSize(9.5).fillColor(COLORS.dark)
       .text('Sampaloc, Manila, Philippines', textX, 83, { width: right - textX });

    // Gold accent line across the page
    doc.rect(0, 101, doc.page.width, 3).fill(COLORS.accent);

    doc.font('Helvetica').fillColor(COLORS.dark);
    doc.y = 110;
  },

  // ─── PDFKit: Assessment Tools table ──────────────────────────
  _pdfAssessmentTools(doc, tools, report) {
    const left = 30;
    const right = doc.page.width - 30;
    const contentW = right - left;
    const pad = 4;
    const fontSize = 8;

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

    // Section header
    if (doc.y > 690) { doc.addPage(); this._pdfPageHeader(doc, report); }
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(COLORS.accent).lineWidth(1).stroke();
    doc.fontSize(9).fillColor(COLORS.primary).font('Helvetica-Bold')
       .text('ASSESSMENT TOOLS / PROCEDURE', left, doc.y + 3);
    doc.y += 16;

    const drawHeaderRow = () => {
      const hY = doc.y;
      doc.font('Helvetica-Bold').fontSize(fontSize);
      let hH = 0;
      defs.forEach((d) => { hH = Math.max(hH, doc.heightOfString(d.label, { width: d.width - pad * 2 })); });
      hH += pad * 2;
      doc.rect(left, hY, contentW, hH).fill(COLORS.primary);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(fontSize);
      defs.forEach((d) => { doc.text(d.label, d.x + pad, hY + pad, { width: d.width - pad * 2, align: d.align }); });
      doc.y = hY + hH;
    };

    drawHeaderRow();

    let zebra = false;
    tools.forEach((t) => {
      // Measure tallest cell for this row
      let rH = 0;
      defs.forEach((d) => {
        const txt = d.key === 'name' ? t.name : valFor(t, d.key);
        doc.font(d.key === 'name' ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
        rH = Math.max(rH, doc.heightOfString(txt || '—', { width: d.width - pad * 2 }));
      });
      rH += pad * 2;

      if (doc.y + rH > doc.page.height - 40) {
        doc.addPage();
        this._pdfPageHeader(doc, report);
        drawHeaderRow();
      }

      const rY = doc.y;
      if (zebra) doc.rect(left, rY, contentW, rH).fill(COLORS.bgLight);
      zebra = !zebra;

      defs.forEach((d) => {
        const isName = d.key === 'name';
        const txt = isName ? t.name : valFor(t, d.key);
        doc.font(isName ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize)
           .fillColor(isName ? COLORS.dark : COLORS.text)
           .text(txt || '—', d.x + pad, rY + pad, { width: d.width - pad * 2, align: d.align });
      });
      doc.moveTo(left, rY + rH).lineTo(right, rY + rH).strokeColor(COLORS.border).lineWidth(0.5).stroke();
      doc.y = rY + rH;
    });

    doc.y += 6;
  },

  // ─── PDFKit: Mental Health Certificate page ──────────────────
  _pdfCertificatePage(doc, report, approvals) {
    doc.addPage();

    this._pdfLetterhead(doc);
    doc.font('Helvetica-Bold').fontSize(14).fillColor(COLORS.primary)
       .text('MENTAL HEALTH CERTIFICATE', 30, doc.y, { align: 'center', width: doc.page.width - 60, characterSpacing: 1.5 });
    doc.fillColor(COLORS.dark);
    doc.y += 12;

    // Patient information box
    const cY = doc.y;
    doc.rect(28, cY, doc.page.width - 56, 52)
       .lineWidth(0.5).strokeColor(COLORS.border).fillColor(COLORS.bgLight).fillAndStroke();
    doc.fontSize(8).fillColor(COLORS.primary).font('Helvetica-Bold').text('PATIENT INFORMATION', 38, cY + 5);
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.dark);
    let rowY = cY + 18;
    doc.font('Helvetica-Bold').text('Full Name:', 38, rowY);
    doc.font('Helvetica').text(report.client_name || 'N/A', 100, rowY);
    doc.font('Helvetica-Bold').text('Age:', 310, rowY);
    doc.font('Helvetica').text(report.client_age ? `${report.client_age} years old` : 'N/A', 340, rowY);
    rowY += 14;
    doc.font('Helvetica-Bold').text('Gender:', 38, rowY);
    doc.font('Helvetica').text(report.client_gender || 'N/A', 100, rowY);
    doc.font('Helvetica-Bold').text('Date:', 310, rowY);
    const dateStr = report.date_of_assessment
      ? new Date(report.date_of_assessment).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'N/A';
    doc.font('Helvetica').text(dateStr, 340, rowY);
    doc.y = cY + 62;

    // Participating staff
    doc.moveTo(30, doc.y).lineTo(doc.page.width - 30, doc.y).strokeColor(COLORS.accent).lineWidth(1).stroke();
    doc.fontSize(9).fillColor(COLORS.primary).font('Helvetica-Bold').text('PARTICIPATING STAFF', 30, doc.y + 3);
    doc.y += 16;
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.text).text(
      'This certifies that the psychological assessment of the above-named patient was administered and handled by the following staff member(s):',
      30, doc.y, { width: doc.page.width - 60, align: 'justify', lineGap: 1 }
    );
    doc.y += 8;

    const staff = this._participatingStaff(report, approvals);
    if (!staff.length) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLORS.muted)
         .text('No participating staff recorded.', 30, doc.y + 12);
    } else {
      let y = doc.y + 20;
      const colX = [30, 320];
      staff.forEach((s, idx) => {
        const x = colX[idx % 2];
        if (idx % 2 === 0 && idx > 0) y += 56;
        doc.moveTo(x, y + 22).lineTo(x + 210, y + 22).strokeColor(COLORS.dark).lineWidth(0.5).stroke();
        doc.fontSize(9).fillColor(COLORS.dark).font('Helvetica-Bold').text(s.name, x, y + 25, { width: 210 });
        doc.fontSize(7).fillColor(COLORS.muted).font('Helvetica').text(s.role, x, y + 37, { width: 210 });
      });
    }
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
  _pdfTable(doc, headers, rows, report, weights) {
    const left = 30;
    const right = doc.page.width - 30;
    const contentW = right - left;
    const pad = 4;
    const fontSize = 8.5;

    const w = (weights && weights.length === headers.length)
      ? weights.slice()
      : headers.map((_, i) => (i === 0 ? 1.8 : 1));
    const totalW = w.reduce((s, n) => s + n, 0);
    const defs = headers.map((h, i) => ({ label: h, w: w[i] }));
    let x = left;
    defs.forEach((d) => { d.width = contentW * (d.w / totalW); d.x = x; x += d.width; });

    const drawHeaderRow = () => {
      const hY = doc.y;
      doc.font('Helvetica-Bold').fontSize(fontSize);
      let hH = 0;
      defs.forEach((d) => { hH = Math.max(hH, doc.heightOfString(d.label, { width: d.width - pad * 2 })); });
      hH += pad * 2;
      doc.rect(left, hY, contentW, hH).fill(COLORS.primary);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(fontSize);
      defs.forEach((d) => { doc.text(d.label, d.x + pad, hY + pad, { width: d.width - pad * 2 }); });
      doc.y = hY + hH;
    };

    if (doc.y > 690) { doc.addPage(); this._pdfPageHeader(doc, report); }
    drawHeaderRow();

    let zebra = false;
    rows.forEach((row) => {
      let rH = 0;
      defs.forEach((d, ci) => {
        doc.font(ci === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
        rH = Math.max(rH, doc.heightOfString(row[ci] || '—', { width: d.width - pad * 2 }));
      });
      rH += pad * 2;

      if (doc.y + rH > doc.page.height - 40) {
        doc.addPage(); this._pdfPageHeader(doc, report); drawHeaderRow();
      }
      const rY = doc.y;
      if (zebra) doc.rect(left, rY, contentW, rH).fill(COLORS.bgLight);
      zebra = !zebra;
      defs.forEach((d, ci) => {
        doc.font(ci === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize)
           .fillColor(ci === 0 ? COLORS.dark : COLORS.text)
           .text(row[ci] || '—', d.x + pad, rY + pad, { width: d.width - pad * 2 });
      });
      doc.moveTo(left, rY + rH).lineTo(right, rY + rH).strokeColor(COLORS.border).lineWidth(0.5).stroke();
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

    add(report.psychologist_name, 'Examining Psychologist');
    (approvals || []).forEach((a) => {
      const role = a.decision === 'approved' ? 'Clinical Director (Approved)' : 'Reviewer';
      add(a.reviewer_name, role);
    });
    return staff;
  },
};

module.exports = PdfGenerator;
