/**
 * DocuSeal E-Signature Service
 * Handles PDF upload and signature submission via DocuSeal API.
 */

const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY || '';
const DOCUSEAL_BASE_URL = 'https://api.docuseal.com';

const DocuSealService = {
  /**
   * Create a signature submission from a PDF buffer.
   * @param {Buffer} pdfBuffer - The PDF file buffer
   * @param {string} signerEmail - Email of the signer
   * @param {string} signerName - Name of the signer
   * @param {string} reportTitle - Title for the document
   * @returns {Object} Submission data with signing URL
   */
  async createSubmissionFromPdf(pdfBuffer, signerEmail, signerName, reportTitle) {
    if (!DOCUSEAL_API_KEY) {
      throw new Error('DocuSeal API key not configured');
    }

    // Step 1: Create submission directly from PDF using /submissions/pdf
    const FormData = (await import('node:buffer')).Buffer;

    const boundary = '----FormBoundary' + Date.now().toString(36);
    const fileName = `${reportTitle.replace(/\s+/g, '_')}.pdf`;

    // Build multipart form data manually
    const parts = [];

    // PDF file part
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="pdf"; filename="${fileName}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    );
    parts.push(pdfBuffer);
    parts.push('\r\n');

    // Submitters
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="submitters[0][email]"\r\n\r\n` +
      `${signerEmail}\r\n`
    );
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="submitters[0][name]"\r\n\r\n` +
      `${signerName}\r\n`
    );
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="submitters[0][role]"\r\n\r\n` +
      `Signer\r\n`
    );

    parts.push(`--${boundary}--\r\n`);

    // Combine parts into a single buffer
    const bodyParts = parts.map(p => typeof p === 'string' ? Buffer.from(p) : p);
    const body = Buffer.concat(bodyParts);

    const response = await fetch(`${DOCUSEAL_BASE_URL}/submissions/pdf`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': DOCUSEAL_API_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('DocuSeal API error:', response.status, errorText);
      throw new Error(`DocuSeal API error: ${response.status}`);
    }

    const data = await response.json();
    return data;
  },

  /**
   * Alternative: Create submission using JSON with base64 PDF
   */
  async createSubmissionBase64(pdfBuffer, signerEmail, signerName, reportTitle) {
    if (!DOCUSEAL_API_KEY) {
      throw new Error('DocuSeal API key not configured');
    }

    const base64Pdf = pdfBuffer.toString('base64');

    const response = await fetch(`${DOCUSEAL_BASE_URL}/submissions/pdf`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': DOCUSEAL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file: base64Pdf,
        submitters: [{
          email: signerEmail,
          name: signerName,
          role: 'Signer',
        }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('DocuSeal JSON API error:', response.status, errorText);
      throw new Error(`DocuSeal API error: ${response.status}`);
    }

    return await response.json();
  },

  /**
   * Get submission status
   */
  async getSubmission(submissionId) {
    const response = await fetch(`${DOCUSEAL_BASE_URL}/submissions/${submissionId}`, {
      headers: { 'X-Auth-Token': DOCUSEAL_API_KEY },
    });
    if (!response.ok) throw new Error(`DocuSeal API error: ${response.status}`);
    return await response.json();
  },
};

module.exports = DocuSealService;
