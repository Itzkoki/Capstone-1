/* ══════════════════════════════════════════════════════════
   PSYGEN — E-Sign: PDF preview, DocuSeal builder & form,
            canvas signature drawing, file upload
   ══════════════════════════════════════════════════════════ */

let currentPdfBlob = null;
let currentPdfUrl = null;
let currentPdfReportId = null;
let _pendingPdfId = null;

// Show the certificate options modal before generating PDF
function downloadPdf(id) {
  _pendingPdfId = id;
  const modal = document.getElementById('certOptionsModal');
  if (!modal) {
    // Fallback if modal not present — generate without certificate
    _executePdfGenerate(id, false, {});
    return;
  }
  // Reset fields
  document.getElementById('certToggle').checked = false;
  document.getElementById('certFields').style.display = 'none';
  ['certAddress','certPurpose','certImpression','certValidity',
   'certLicenseNo','certPtrNo','certLicenseValidity'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  modal.style.display = 'flex';
}

function closeCertOptionsModal() {
  const modal = document.getElementById('certOptionsModal');
  if (modal) modal.style.display = 'none';
  _pendingPdfId = null;
}

function toggleCertFields() {
  const on = document.getElementById('certToggle').checked;
  document.getElementById('certFields').style.display = on ? 'block' : 'none';
}

async function doPdfGenerate() {
  const id = _pendingPdfId;
  if (!id) return;

  const includeCert = document.getElementById('certToggle') && document.getElementById('certToggle').checked;
  const certOpts = {};
  if (includeCert) {
    certOpts.cert_address           = document.getElementById('certAddress').value.trim();
    certOpts.cert_purpose           = document.getElementById('certPurpose').value.trim();
    certOpts.cert_impression        = document.getElementById('certImpression').value.trim();
    certOpts.cert_validity          = document.getElementById('certValidity').value.trim();
    certOpts.cert_license_no        = document.getElementById('certLicenseNo').value.trim();
    certOpts.cert_ptr_no            = document.getElementById('certPtrNo').value.trim();
    certOpts.cert_license_validity  = document.getElementById('certLicenseValidity').value.trim();
  }

  closeCertOptionsModal();
  await _executePdfGenerate(id, includeCert, certOpts);
}

async function _executePdfGenerate(id, includeCert, certOpts) {
  showLoading();
  try {
    let url = API + '/reports/' + id + '/pdf';
    if (includeCert) {
      const params = new URLSearchParams({ include_certificate: '1', ...certOpts });
      url += '?' + params.toString();
    }
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
    if (!res.ok) throw new Error('Failed to generate PDF');
    currentPdfBlob = await res.blob();
    currentPdfUrl = URL.createObjectURL(currentPdfBlob);
    currentPdfReportId = id;
    const modal = document.getElementById('pdfPreviewModal');
    const iframe = document.getElementById('pdfPreviewFrame');
    iframe.src = currentPdfUrl;
    modal.classList.add('active');
  } catch(e) { toast(e.message, 'error'); }
  hideLoading();
}

function closePdfPreview() {
  const modal = document.getElementById('pdfPreviewModal');
  modal.classList.remove('active');
  const iframe = document.getElementById('pdfPreviewFrame');
  iframe.src = '';
  document.getElementById('esignContainer').classList.add('hidden');
  document.getElementById('pdfPreviewContainer').classList.remove('hidden');
  if (typeof clearDocusealForm === 'function') clearDocusealForm();
}

function doDownloadPdf() {
  if (!currentPdfUrl) return;
  const a = document.createElement('a');
  a.href = currentPdfUrl;
  a.download = `PsychReport_${currentPdfReportId}.pdf`;
  a.click();
  toast('PDF downloaded!');
}

// ── E-Signature Draw/Upload Modal ───────────────────────────
let signatureCanvas = null;
let signatureCtx = null;
let isDrawing = false;
let signatureStrokes = [];
let currentStroke = [];
let signaturePenColor = '#1a2e1a';
let signaturePenSize = 2;
let uploadedSignatureData = null;
let esignActiveTab = 'draw';

function openEsignModal() {
  if (!currentPdfReportId) return;
  launchEsignBuilder();
}

// ── DocuSeal Form Builder flow ──────────────────────────────
let esignTemplateId = null;

async function launchEsignBuilder() {
  showLoading();
  try {
    const res = await fetch(API + '/reports/' + currentPdfReportId + '/esign/builder', {
      method: 'POST',
      headers: headers(),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || 'Failed to open signature builder');

    esignTemplateId = d.template_id;
    document.getElementById('pdfPreviewContainer').classList.add('hidden');
    document.getElementById('esignContainer').classList.remove('hidden');
    setEsignLabel('Drag the Signature field where you want it, then click Save');
    mountDocusealBuilder(d.builder_token);
    toast('Place your signature field on the document, then Save.');
  } catch (e) {
    toast(e.message || 'Failed to open signature builder', 'error');
  }
  hideLoading();
}

function setEsignLabel(text) {
  const el = document.getElementById('esignLabel');
  if (el) el.textContent = text;
}

function mountDocusealBuilder(token) {
  const mount = document.getElementById('esignFrame');
  if (!mount) return;
  mount.innerHTML = '';

  const builder = document.createElement('docuseal-builder');
  builder.id = 'docusealBuilder';
  builder.setAttribute('data-token', token);
  builder.setAttribute('data-roles', 'Signer');
  builder.setAttribute('data-only-defined-fields', 'false');
  builder.style.display = 'block';
  builder.style.width = '100%';
  builder.style.minHeight = '70vh';

  const goSign = () => proceedToSigning();
  builder.addEventListener('save', goSign);
  builder.addEventListener('send', goSign);

  mount.appendChild(builder);
}

async function proceedToSigning() {
  if (!esignTemplateId) return;
  showLoading();
  try {
    const res = await fetch(API + '/reports/' + currentPdfReportId + '/esign/submission', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ template_id: esignTemplateId }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || 'Failed to start signing');

    if (d.signing_url) {
      setEsignLabel('Sign the document below');
      mountDocusealForm(d.signing_url);
      toast('Now sign the document.');
    } else {
      throw new Error('No signing URL returned');
    }
  } catch (e) {
    toast(e.message || 'Failed to start signing', 'error');
  }
  hideLoading();
}

function closeEsignModal() {
  document.getElementById('esignDrawModal').classList.remove('active');
}

function switchEsignTab(tab) {
  esignActiveTab = tab;
  document.getElementById('esignTabDraw').classList.toggle('active', tab === 'draw');
  document.getElementById('esignTabUpload').classList.toggle('active', tab === 'upload');
  document.getElementById('esignPanelDraw').classList.toggle('hidden', tab !== 'draw');
  document.getElementById('esignPanelUpload').classList.toggle('hidden', tab !== 'upload');
  if (tab === 'draw') initSignatureCanvas();
  if (tab === 'upload') initUploadZone();
}

// ── Canvas Drawing ──────────────────────────────────────────
function initSignatureCanvas() {
  signatureCanvas = document.getElementById('esignCanvas');
  signatureCtx = signatureCanvas.getContext('2d');

  const rect = signatureCanvas.getBoundingClientRect();
  signatureCanvas.width = rect.width * 2;
  signatureCanvas.height = rect.height * 2;
  signatureCtx.scale(2, 2);
  redrawCanvas();

  const newCanvas = signatureCanvas.cloneNode(true);
  signatureCanvas.parentNode.replaceChild(newCanvas, signatureCanvas);
  signatureCanvas = newCanvas;
  signatureCtx = signatureCanvas.getContext('2d');
  const r2 = signatureCanvas.getBoundingClientRect();
  signatureCanvas.width = r2.width * 2;
  signatureCanvas.height = r2.height * 2;
  signatureCtx.scale(2, 2);
  redrawCanvas();

  signatureCanvas.addEventListener('mousedown', startDraw);
  signatureCanvas.addEventListener('mousemove', draw);
  signatureCanvas.addEventListener('mouseup', endDraw);
  signatureCanvas.addEventListener('mouseleave', endDraw);
  signatureCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); startDraw(e.touches[0]); }, { passive: false });
  signatureCanvas.addEventListener('touchmove', (e) => { e.preventDefault(); draw(e.touches[0]); }, { passive: false });
  signatureCanvas.addEventListener('touchend', (e) => { e.preventDefault(); endDraw(); }, { passive: false });
}

function getCanvasPos(e) {
  const rect = signatureCanvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left), y: (e.clientY - rect.top) };
}

function startDraw(e) {
  isDrawing = true;
  currentStroke = [];
  const pos = getCanvasPos(e);
  currentStroke.push({ ...pos, color: signaturePenColor, size: signaturePenSize });
  signatureCtx.beginPath();
  signatureCtx.moveTo(pos.x, pos.y);
  signatureCtx.strokeStyle = signaturePenColor;
  signatureCtx.lineWidth = signaturePenSize;
  signatureCtx.lineCap = 'round';
  signatureCtx.lineJoin = 'round';
}

function draw(e) {
  if (!isDrawing) return;
  const pos = getCanvasPos(e);
  currentStroke.push({ ...pos, color: signaturePenColor, size: signaturePenSize });
  signatureCtx.lineTo(pos.x, pos.y);
  signatureCtx.stroke();
}

function endDraw() {
  if (!isDrawing) return;
  isDrawing = false;
  if (currentStroke.length > 0) signatureStrokes.push([...currentStroke]);
  currentStroke = [];
}

function redrawCanvas() {
  if (!signatureCtx) return;
  const rect = signatureCanvas.getBoundingClientRect();
  signatureCtx.clearRect(0, 0, rect.width, rect.height);

  signatureCtx.save();
  signatureCtx.strokeStyle = '#c5ecd8';
  signatureCtx.lineWidth = 1;
  signatureCtx.setLineDash([4, 4]);
  signatureCtx.beginPath();
  signatureCtx.moveTo(40, rect.height - 50);
  signatureCtx.lineTo(rect.width - 40, rect.height - 50);
  signatureCtx.stroke();
  signatureCtx.setLineDash([]);
  signatureCtx.restore();

  for (const stroke of signatureStrokes) {
    if (stroke.length < 2) continue;
    signatureCtx.beginPath();
    signatureCtx.moveTo(stroke[0].x, stroke[0].y);
    signatureCtx.strokeStyle = stroke[0].color;
    signatureCtx.lineWidth = stroke[0].size;
    signatureCtx.lineCap = 'round';
    signatureCtx.lineJoin = 'round';
    for (let i = 1; i < stroke.length; i++) signatureCtx.lineTo(stroke[i].x, stroke[i].y);
    signatureCtx.stroke();
  }
}

function clearSignatureCanvas() {
  signatureStrokes = [];
  currentStroke = [];
  redrawCanvas();
}

function undoSignatureStroke() {
  if (signatureStrokes.length === 0) return;
  signatureStrokes.pop();
  redrawCanvas();
}

function setSignatureColor(color, btn) {
  signaturePenColor = color;
  document.querySelectorAll('.esign-color-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function setSignaturePenSize(size) {
  signaturePenSize = parseInt(size);
}

// ── Upload Handling ─────────────────────────────────────────
function initUploadZone() {
  const zone = document.getElementById('esignUploadZone');
  if (zone.dataset.initDrag) return;
  zone.dataset.initDrag = '1';

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processUploadedFile(file);
  });
}

function handleEsignUpload(e) {
  const file = e.target.files[0];
  if (file) processUploadedFile(file);
  e.target.value = '';
}

function processUploadedFile(file) {
  if (!file.type.startsWith('image/')) { toast('Please upload an image file (PNG, JPG, or SVG)', 'error'); return; }
  if (file.size > 2 * 1024 * 1024) { toast('File too large. Maximum size is 2MB.', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    uploadedSignatureData = e.target.result;
    document.getElementById('esignUploadImg').src = uploadedSignatureData;
    document.getElementById('esignUploadZone').classList.add('hidden');
    document.getElementById('esignUploadPreview').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function removeEsignUpload() {
  uploadedSignatureData = null;
  document.getElementById('esignUploadImg').src = '';
  document.getElementById('esignUploadPreview').classList.add('hidden');
  document.getElementById('esignUploadZone').classList.remove('hidden');
}

// ── Apply Signature ─────────────────────────────────────────
async function applySignature() {
  let signatureDataUrl = null;

  if (esignActiveTab === 'draw') {
    if (signatureStrokes.length === 0) { toast('Please draw your signature first', 'error'); return; }
    signatureDataUrl = signatureCanvas.toDataURL('image/png');
  } else {
    if (!uploadedSignatureData) { toast('Please upload a signature image first', 'error'); return; }
    signatureDataUrl = uploadedSignatureData;
  }

  closeEsignModal();
  showLoading();

  try {
    const res = await fetch(API + '/reports/' + currentPdfReportId + '/esign', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ signature_image: signatureDataUrl })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || 'Failed to apply signature');

    if (d.signing_url) {
      document.getElementById('pdfPreviewContainer').classList.add('hidden');
      const esignContainer = document.getElementById('esignContainer');
      esignContainer.classList.remove('hidden');
      mountDocusealForm(d.signing_url);
      toast('E-signature form loaded! Sign the document below.');
    } else {
      toast('Signature applied successfully!');
      try {
        const pdfRes = await fetch(API + '/reports/' + currentPdfReportId + '/pdf', {
          headers: { 'Authorization': 'Bearer ' + TOKEN }
        });
        if (pdfRes.ok) {
          currentPdfBlob = await pdfRes.blob();
          if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
          currentPdfUrl = URL.createObjectURL(currentPdfBlob);
          document.getElementById('pdfPreviewFrame').src = currentPdfUrl;
        }
      } catch (refreshErr) { console.warn('PDF refresh failed:', refreshErr); }
    }
  } catch (e) {
    toast(e.message || 'Failed to apply signature', 'error');
  }

  hideLoading();
  signatureStrokes = [];
  currentStroke = [];
  uploadedSignatureData = null;
}

function backToPdfPreview() {
  document.getElementById('esignContainer').classList.add('hidden');
  document.getElementById('pdfPreviewContainer').classList.remove('hidden');
  clearDocusealForm();
}

// ── DocuSeal embedded signing form ──────────────────────────
function mountDocusealForm(signingUrl) {
  const mount = document.getElementById('esignFrame');
  if (!mount) return;
  mount.innerHTML = '';

  const form = document.createElement('docuseal-form');
  form.id = 'docusealForm';
  form.setAttribute('data-src', signingUrl);
  form.style.display = 'block';
  form.style.width = '100%';

  form.addEventListener('completed', async () => {
    toast('Document signed successfully!');
    try {
      const pdfRes = await fetch(API + '/reports/' + currentPdfReportId + '/pdf', {
        headers: { 'Authorization': 'Bearer ' + TOKEN }
      });
      if (pdfRes.ok) {
        currentPdfBlob = await pdfRes.blob();
        if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
        currentPdfUrl = URL.createObjectURL(currentPdfBlob);
        document.getElementById('pdfPreviewFrame').src = currentPdfUrl;
      }
    } catch (_) { /* non-fatal */ }
  });

  mount.appendChild(form);
}

function clearDocusealForm() {
  const mount = document.getElementById('esignFrame');
  if (mount) mount.innerHTML = '';
}