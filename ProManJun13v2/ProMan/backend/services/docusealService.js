/**
 * DocuSeal E-Signature Service
 * Handles PDF upload and submission creation via the DocuSeal API.
 *
 * Endpoint used: POST https://api.docuseal.com/submissions/pdf
 * Required body shape (this is what the 422 was about):
 *   {
 *     name: "Document title",
 *     documents: [{ name, file: <base64>, fields?: [...] }],   // <-- file MUST be inside documents[]
 *     submitters: [{ role, email, name }]
 *   }
 * The previous code sent a top-level `file`, which DocuSeal rejects with 422.
 */

const jwt = require('jsonwebtoken');

const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY || '';
const DOCUSEAL_BASE_URL = process.env.DOCUSEAL_BASE_URL || 'https://api.docuseal.com';
// Email of the DocuSeal account that owns the API key (the admin user).
// Required by the embedded form builder. Set DOCUSEAL_ADMIN_EMAIL in .env.
const DOCUSEAL_ADMIN_EMAIL = process.env.DOCUSEAL_ADMIN_EMAIL || '';

/**
 * Build a default signature + date field placed near the bottom-left of the
 * first page. DocuSeal area coordinates are RELATIVE fractions of the page
 * (0..1), and `page` is 1-indexed (page must be > 0; page 1 = first page).
 * Using page 1 guarantees the field lands on a real page regardless of how
 * many pages the report has.
 *
 * In the embedded signing form the signer can move/resize this field, and the
 * placed signature is baked into the final PDF by DocuSeal.
 */
function defaultSignatureFields(role) {
  return [
    {
      name: 'Signature',
      type: 'signature',
      role,
      required: true,
      areas: [{ x: 0.08, y: 0.82, w: 0.32, h: 0.08, page: 1 }],
    },
  ];
}

async function postJson(path, payload) {
  const response = await fetch(`${DOCUSEAL_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  if (!response.ok) {
    // Surface DocuSeal's actual validation message so a future 422 is debuggable
    console.error('DocuSeal API error:', response.status, raw);
    throw new Error(`DocuSeal API error: ${response.status} — ${raw.slice(0, 500)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const DocuSealService = {
  /**
   * Create a one-off signature submission directly from a PDF buffer.
   * Returns DocuSeal's response (an array of submitter objects, each with
   * `slug` and `embed_src` for embedded signing).
   *
   * @param {Buffer}  pdfBuffer   The PDF file buffer
   * @param {string}  signerEmail Email of the signer
   * @param {string}  signerName  Name of the signer
   * @param {string}  reportTitle Title for the document
   * @param {object} [opts]       { role, fields, sendEmail }
   */
  async createSubmissionFromPdf(pdfBuffer, signerEmail, signerName, reportTitle, opts = {}) {
    if (!DOCUSEAL_API_KEY) {
      throw new Error('DocuSeal API key not configured');
    }

    const role = opts.role || 'Signer';
    const fields = opts.fields || defaultSignatureFields(role);
    const fileName = `${String(reportTitle).replace(/\s+/g, '_')}.pdf`;
    const base64Pdf = pdfBuffer.toString('base64');

    const payload = {
      name: reportTitle,
      // send_email:false keeps it embedded-only (no email invite). Flip to true
      // if you also want DocuSeal to email the signer a link.
      send_email: opts.sendEmail === true,
      documents: [
        {
          name: fileName,
          file: base64Pdf,
          fields,
        },
      ],
      submitters: [
        {
          role,
          email: signerEmail,
          name: signerName,
        },
      ],
    };

    return postJson('/submissions/pdf', payload);
  },

  /**
   * Backwards-compatible alias. The controller calls createSubmissionBase64;
   * it now routes through the corrected createSubmissionFromPdf.
   */
  async createSubmissionBase64(pdfBuffer, signerEmail, signerName, reportTitle, opts = {}) {
    return this.createSubmissionFromPdf(pdfBuffer, signerEmail, signerName, reportTitle, opts);
  },

  // ────────────────────────────────────────────────────────────────
  // FORM BUILDER flow (drag/place/resize the signature, then sign)
  // ────────────────────────────────────────────────────────────────

  /**
   * Create a reusable DocuSeal *template* from a PDF buffer (base64).
   * No fields are predefined — the user will place the signature in the
   * embedded form builder. Returns the template object (includes `id`).
   */
  async createTemplateFromPdf(pdfBuffer, name) {
    if (!DOCUSEAL_API_KEY) throw new Error('DocuSeal API key not configured');

    const fileName = `${String(name).replace(/\s+/g, '_')}.pdf`;
    const payload = {
      name,
      documents: [
        { name: fileName, file: pdfBuffer.toString('base64') },
      ],
    };
    return postJson('/templates/pdf', payload);
  },

  /**
   * Mint the HS256 JWT the <docuseal-builder> component requires. It is
   * signed with the DocuSeal API key and must be generated on the backend.
   *
   * @param {object} opts { templateId, integrationEmail }
   */
  buildBuilderToken({ templateId, integrationEmail }) {
    if (!DOCUSEAL_API_KEY) throw new Error('DocuSeal API key not configured');
    if (!DOCUSEAL_ADMIN_EMAIL) {
      throw new Error('DOCUSEAL_ADMIN_EMAIL not configured (must be the email of the DocuSeal account that owns the API key)');
    }

    const payload = {
      user_email: DOCUSEAL_ADMIN_EMAIL,
      integration_email: integrationEmail,
      template_id: templateId,
    };
    // DocuSeal expects a plain HS256 token signed with the API key.
    return jwt.sign(payload, DOCUSEAL_API_KEY, { algorithm: 'HS256' });
  },

  /**
   * Create a signing submission from an existing template (used after the
   * user has placed their signature field in the builder). Returns the
   * DocuSeal response (array of submitters, each with `embed_src`).
   */
  async createSubmissionFromTemplate(templateId, signerEmail, signerName, role = 'Signer') {
    if (!DOCUSEAL_API_KEY) throw new Error('DocuSeal API key not configured');

    const payload = {
      template_id: templateId,
      send_email: false,
      submitters: [
        { role, email: signerEmail, name: signerName },
      ],
    };
    return postJson('/submissions', payload);
  },

  /**
   * Fetch submission status / details.
   */
  async getSubmission(submissionId) {
    if (!DOCUSEAL_API_KEY) throw new Error('DocuSeal API key not configured');
    const response = await fetch(`${DOCUSEAL_BASE_URL}/submissions/${submissionId}`, {
      headers: { 'X-Auth-Token': DOCUSEAL_API_KEY },
    });
    const raw = await response.text();
    if (!response.ok) {
      console.error('DocuSeal getSubmission error:', response.status, raw);
      throw new Error(`DocuSeal API error: ${response.status} — ${raw.slice(0, 500)}`);
    }
    return JSON.parse(raw);
  },
};

module.exports = DocuSealService;
