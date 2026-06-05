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
  primary: '#1a2e1a',     // dark green text
  secondary: '#28a745',   // green dark
  accent: '#34c759',      // green primary
  accentLight: '#4dd882', // hero button green
  dark: '#1a2e1a',
  text: '#3a5a3a',
  muted: '#6b8a6b',
  border: '#c5ecd8',
  bgLight: '#f0f9f0',
  white: '#ffffff',
  watermark: 'rgba(52, 199, 89, 0.06)',
};

const PdfGenerator = {
  async generate(report, sections, testScores, assessmentData, approvals) {
    const html = this._buildHtml(report, sections, testScores, assessmentData, approvals);

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

    return this._generateWithPdfKit(report, sections, testScores, assessmentData, approvals);
  },

  // ─── HTML Builder ────────────────────────────────────────────
  _buildHtml(report, sections, testScores, assessmentData, approvals) {
    const templateName = (report.template_name || report.template_type || '').toUpperCase();
    const assessDate = report.date_of_assessment
      ? new Date(report.date_of_assessment).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
      : 'N/A';
    const approval = approvals && approvals.find(a => a.decision === 'approved');

    const logoImg = LOGO_BASE64
      ? `<img src="data:image/png;base64,${LOGO_BASE64}" class="header-logo" alt="BPS Logo">`
      : '';

    const sectionsHtml = sections
      .filter(s => s.content || s.section_key === 'identifying_information')
      .map(s => `
        <div class="section">
          <h2>${this._esc(s.section_title)}</h2>
          <div class="section-content">${this._esc(s.content || '(No content)').replace(/\n/g, '<br>')}</div>
        </div>
      `).join('');

    let scoresHtml = '';
    if (testScores && testScores.length > 0) {
      scoresHtml = `
        <div class="section">
          <h2>TEST SCORES SUMMARY</h2>
          <table class="scores-table">
            <thead><tr>
              <th>Test Name</th><th>Category</th><th>Raw Score</th>
              <th>Percentile</th><th>Standard Score</th><th>Descriptive Range</th>
            </tr></thead>
            <tbody>
              ${testScores.map((s, i) => `
                <tr class="${i % 2 === 0 ? 'even' : ''}">
                  <td>${this._esc(s.test_name || '')}</td>
                  <td>${this._esc(s.test_category || '')}</td>
                  <td class="center">${s.raw_score != null ? s.raw_score : '-'}</td>
                  <td class="center">${s.percentile_score != null ? s.percentile_score : '-'}</td>
                  <td class="center">${s.standard_score != null ? s.standard_score : '-'}</td>
                  <td>${this._esc(s.descriptive_range || '-')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', Arial, sans-serif; font-size: 11px; color: #3a5a3a; line-height: 1.6; }

  /* Watermark on every page */
  @media print {
    body::after { content: 'CONFIDENTIAL'; position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-45deg); font-size: 120px; font-weight: 900; color: rgba(52,199,89,0.08); letter-spacing: 16px; pointer-events: none; z-index: 0; white-space: nowrap; }
  }
  .watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-45deg); font-size: 120px; font-weight: 900; color: rgba(52,199,89,0.08); letter-spacing: 16px; pointer-events: none; z-index: 0; white-space: nowrap; }

  .header { background: linear-gradient(135deg, #a8e6cf 0%, #88d8a8 100%); color: #1a2e1a; padding: 20px 30px; text-align: center; position: relative; }
  .header-logo { width: 60px; height: 60px; border-radius: 50%; margin-bottom: 8px; border: 2px solid rgba(26,46,26,0.15); }
  .header h1 { font-size: 18px; font-weight: 700; letter-spacing: 2px; margin-bottom: 4px; color: #1a2e1a; }
  .header .subtitle { font-size: 10px; color: #2d5a2d; letter-spacing: 1px; }
  .header .template-type { font-size: 9px; color: #3a6b3a; letter-spacing: 1.5px; margin-top: 4px; }

  .content { padding: 16px 30px; position: relative; z-index: 1; }

  .client-info { border: 1px solid #c5ecd8; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; background: #f0f9f0; }
  .client-info h3 { font-size: 11px; color: #1a2e1a; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; font-weight: 700; border-bottom: 1px solid #c5ecd8; padding-bottom: 4px; }
  .client-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; }
  .client-field { font-size: 10px; }
  .client-field strong { color: #1a2e1a; font-weight: 600; }

  .section { margin-bottom: 12px; page-break-inside: avoid; }
  .section h2 { font-size: 12px; color: #1a2e1a; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 700; padding-bottom: 4px; border-bottom: 2px solid #34c759; margin-bottom: 6px; }
  .section-content { font-size: 10.5px; color: #3a5a3a; line-height: 1.65; text-align: justify; }

  .scores-table { width: 100%; border-collapse: collapse; font-size: 9px; margin-top: 6px; }
  .scores-table th { background: linear-gradient(135deg, #a8e6cf, #88d8a8); color: #1a2e1a; padding: 5px 8px; text-align: left; font-weight: 600; font-size: 8.5px; }
  .scores-table td { padding: 4px 8px; border-bottom: 1px solid #c5ecd8; }
  .scores-table tr.even td { background: #f0f9f0; }
  .scores-table .center { text-align: center; }

  .signatures { display: flex; justify-content: space-between; margin-top: 24px; padding-top: 12px; border-top: 2px solid #34c759; page-break-inside: avoid; }
  .sig-block { width: 45%; }
  .sig-label { font-size: 9px; color: #6b8a6b; margin-bottom: 24px; }
  .sig-line { border-bottom: 1px solid #1a2e1a; margin-bottom: 6px; }
  .sig-name { font-size: 11px; font-weight: 700; color: #1a2e1a; }
  .sig-title { font-size: 8px; color: #6b8a6b; }

  .pdf-footer { text-align: center; font-size: 7px; color: #6b8a6b; margin-top: 16px; padding-top: 6px; border-top: 1px solid #c5ecd8; }
</style>
</head>
<body>
  <div class="watermark">CONFIDENTIAL</div>

  <div class="header">
    ${logoImg}
    <h1>PSYCHOLOGICAL ASSESSMENT REPORT</h1>
    <div class="subtitle">Barcarse Psychological Services</div>
    <div class="template-type">${this._esc(templateName)}</div>
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
    ${scoresHtml}

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
</body>
</html>`;
  },

  // ─── PDFKit Fallback ─────────────────────────────────────────
  async _generateWithPdfKit(report, sections, testScores, assessmentData, approvals) {
    const PDFDocument = require('pdfkit');

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'LETTER',
          bufferPages: true,
          margins: { top: 40, bottom: 40, left: 40, right: 40 },
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

        // ── Header with pastel green ──
        const PASTEL_LEFT = '#a8e6cf';
        const PASTEL_RIGHT = '#88d8a8';
        doc.rect(0, 0, doc.page.width, 90).fill(PASTEL_RIGHT);
        doc.save();
        doc.rect(0, 0, doc.page.width / 2, 90).clip();
        doc.rect(0, 0, doc.page.width, 90).fill(PASTEL_LEFT);
        doc.restore();

        // Logo
        if (fs.existsSync(LOGO_PATH)) {
          try { doc.image(LOGO_PATH, doc.page.width / 2 - 22, 6, { width: 44, height: 44 }); } catch(e) {}
        }

        doc.fontSize(16).fillColor(COLORS.primary)
           .text('PSYCHOLOGICAL ASSESSMENT REPORT', 40, 54, { align: 'center' });
        doc.fontSize(9).fillColor('#2d5a2d')
           .text('Barcarse Psychological Services', 40, 72, { align: 'center' });

        const typeName = (report.template_name || report.template_type || '').toUpperCase();
        if (typeName) {
          doc.fontSize(8).fillColor('#3a6b3a').text(typeName, 40, 83, { align: 'center' });
        }

        doc.fillColor(COLORS.dark);
        doc.y = 100;

        // ── Client Info Box ──
        const cY = doc.y;
        doc.rect(35, cY, doc.page.width - 70, 72)
           .lineWidth(1).strokeColor(COLORS.border).fillColor(COLORS.bgLight).fillAndStroke();
        doc.fontSize(10).fillColor(COLORS.primary).font('Helvetica-Bold')
           .text('CLIENT INFORMATION', 50, cY + 8);
        doc.font('Helvetica').fontSize(9).fillColor(COLORS.dark);
        let rowY = cY + 26;
        doc.font('Helvetica-Bold').text('Full Name:', 50, rowY);
        doc.font('Helvetica').text(report.client_name || 'N/A', 125, rowY);
        doc.font('Helvetica-Bold').text('Age:', 310, rowY);
        doc.font('Helvetica').text(report.client_age ? `${report.client_age} years old` : 'N/A', 345, rowY);
        rowY += 16;
        doc.font('Helvetica-Bold').text('Gender:', 50, rowY);
        doc.font('Helvetica').text(report.client_gender || 'N/A', 125, rowY);
        doc.font('Helvetica-Bold').text('Date:', 310, rowY);
        const dateStr = report.date_of_assessment
          ? new Date(report.date_of_assessment).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
          : 'N/A';
        doc.font('Helvetica').text(dateStr, 345, rowY);
        doc.y = cY + 80;

        // ── Sections ──
        for (const section of sections) {
          if (!section.content && section.section_key !== 'identifying_information') continue;
          if (doc.y > 700) { doc.addPage(); this._pdfPageHeader(doc, report); }
          doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor(COLORS.accent).lineWidth(1.5).stroke();
          doc.fontSize(11).fillColor(COLORS.primary).font('Helvetica-Bold')
             .text(section.section_title.toUpperCase(), 40, doc.y + 6);
          doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.text);
          doc.text(section.content || '(No content)', 40, doc.y + 24, {
            width: doc.page.width - 80, align: 'justify', lineGap: 2,
          });
          doc.y += 8;
        }

        // ── Scores Table ──
        if (testScores && testScores.length > 0) {
          if (doc.y > 600) { doc.addPage(); this._pdfPageHeader(doc, report); }
          const tY = doc.y;
          doc.moveTo(40, tY).lineTo(doc.page.width - 40, tY).strokeColor(COLORS.accent).lineWidth(1.5).stroke();
          doc.fontSize(11).fillColor(COLORS.primary).font('Helvetica-Bold').text('TEST SCORES SUMMARY', 40, tY + 6);
          let tableY = tY + 24;
          const cols = [40, 175, 260, 325, 390, 458];
          const headers = ['Test Name', 'Category', 'Raw', 'Percentile', 'Standard', 'Range'];
          doc.rect(35, tableY - 3, doc.page.width - 70, 18).fill(COLORS.primary);
          doc.fontSize(8).fillColor(COLORS.white).font('Helvetica-Bold');
          headers.forEach((h, i) => doc.text(h, cols[i], tableY, { width: 70 }));
          tableY += 18;
          doc.font('Helvetica').fontSize(8).fillColor(COLORS.dark);
          testScores.forEach((s, idx) => {
            if (tableY > 720) { doc.addPage(); this._pdfPageHeader(doc, report); tableY = 50; }
            if (idx % 2 === 0) { doc.rect(35, tableY - 2, doc.page.width - 70, 16).fill(COLORS.bgLight); doc.fillColor(COLORS.dark); }
            doc.text(s.test_name || '', cols[0], tableY, { width: 130 });
            doc.text(s.test_category || '', cols[1], tableY, { width: 80 });
            doc.text(s.raw_score != null ? String(s.raw_score) : '-', cols[2], tableY, { width: 55 });
            doc.text(s.percentile_score != null ? String(s.percentile_score) : '-', cols[3], tableY, { width: 55 });
            doc.text(s.standard_score != null ? String(s.standard_score) : '-', cols[4], tableY, { width: 55 });
            doc.text(s.descriptive_range || '-', cols[5], tableY, { width: 90 });
            tableY += 16;
          });
          doc.y = tableY + 6;
        }

        // ── Signatures ──
        if (doc.y > 650) { doc.addPage(); this._pdfPageHeader(doc, report); }
        const sY = doc.y + 10;
        doc.moveTo(40, sY).lineTo(doc.page.width - 40, sY).strokeColor(COLORS.accent).lineWidth(1.5).stroke();
        const sigY = sY + 16;
        doc.fontSize(9).fillColor(COLORS.muted).font('Helvetica').text('Prepared By:', 40, sigY);
        doc.moveTo(40, sigY + 35).lineTo(250, sigY + 35).strokeColor(COLORS.dark).lineWidth(0.5).stroke();
        doc.fontSize(10).fillColor(COLORS.dark).font('Helvetica-Bold').text(report.psychologist_name || '___________________', 40, sigY + 40);
        doc.fontSize(8).fillColor(COLORS.muted).font('Helvetica').text('Licensed Psychologist', 40, sigY + 54);

        const approval = approvals && approvals.find(a => a.decision === 'approved');
        doc.fontSize(9).fillColor(COLORS.muted).font('Helvetica').text('Approved By:', 320, sigY);
        doc.moveTo(320, sigY + 35).lineTo(530, sigY + 35).strokeColor(COLORS.dark).lineWidth(0.5).stroke();
        doc.fontSize(10).fillColor(COLORS.dark).font('Helvetica-Bold').text(approval ? approval.reviewer_name : '___________________', 320, sigY + 40);
        doc.fontSize(8).fillColor(COLORS.muted).font('Helvetica').text('Clinical Director', 320, sigY + 54);
        doc.y = sigY + 68;

        // ── Watermark + Footer on all pages ──
        const pages = doc.bufferedPageRange();
        for (let i = 0; i < pages.count; i++) {
          doc.switchToPage(pages.start + i);

          // Watermark
          doc.save();
          doc.translate(doc.page.width / 2, doc.page.height / 2);
          doc.rotate(-45);
          doc.fontSize(100).fillColor(COLORS.accent).opacity(0.07)
             .text('CONFIDENTIAL', -320, -50, { align: 'center', width: 640 });
          doc.opacity(1);
          doc.restore();

          // Footer
          const bottom = doc.page.height - 25;
          doc.fontSize(7).fillColor(COLORS.muted).font('Helvetica');
          doc.text('CONFIDENTIAL — This report is confidential and intended solely for the use of the individual or entity to which it is addressed.',
            40, bottom - 12, { width: doc.page.width - 80, align: 'center' });
          doc.text(`Page ${i + 1} of ${pages.count}`, 40, bottom, { width: doc.page.width - 80, align: 'center' });
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  },

  _pdfPageHeader(doc, report) {
    doc.fontSize(8).fillColor(COLORS.muted)
       .text(`Barcarse Psychological Services — ${report.client_name}`, 40, 20);
    doc.moveTo(40, 33).lineTo(doc.page.width - 40, 33).strokeColor(COLORS.border).stroke();
    doc.y = 40;
    doc.fillColor(COLORS.dark);
  },

  _esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};

module.exports = PdfGenerator;
