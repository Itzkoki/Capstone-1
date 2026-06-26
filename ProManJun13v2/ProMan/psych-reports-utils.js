/* ══════════════════════════════════════════════════════════
   PSYGEN — Utils: modal helpers, date formatting, assessment
            data step, calendar popover
   ══════════════════════════════════════════════════════════ */

// ── Date input year clamp (prevents Chrome's 6-digit year bug) ─
function clampDateYear(el) {
  if (!el.value) return;
  const parts = el.value.split('-');
  if (parts[0] && parts[0].length > 4) {
    parts[0] = parts[0].slice(0, 4);
    el.value = parts.join('-');
  }
}

// ── Modal Helpers ───────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
document.addEventListener('click', e=>{ if(e.target.classList.contains('modal-overlay')) e.target.classList.remove('active'); });

// ── Generic confirm modal (replaces native confirm()) ───────
let _prConfirmCb = null;
function prConfirm(title, msg, cb, danger) {
  _prConfirmCb = cb;
  document.getElementById('prConfirmTitle').textContent = title;
  document.getElementById('prConfirmMsg').textContent = msg;
  const btn = document.getElementById('prConfirmBtn');
  btn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
  openModal('prConfirmModal');
}
function prConfirmYes() {
  closeModal('prConfirmModal');
  if (_prConfirmCb) { const cb = _prConfirmCb; _prConfirmCb = null; cb(); }
}
function prConfirmNo() {
  closeModal('prConfirmModal');
  _prConfirmCb = null;
}

// ── Generic text prompt modal (replaces native prompt()) ────
let _prPromptCb = null;
function prPrompt(title, placeholder, cb, defaultVal) {
  _prPromptCb = cb;
  document.getElementById('prPromptTitle').textContent = title;
  const inp = document.getElementById('prPromptInput');
  inp.placeholder = placeholder || '';
  inp.value = defaultVal || '';
  openModal('prPromptModal');
  setTimeout(() => inp.focus(), 60);
}
function prPromptYes() {
  const val = document.getElementById('prPromptInput').value;
  closeModal('prPromptModal');
  if (_prPromptCb) { const cb = _prPromptCb; _prPromptCb = null; cb(val); }
}
function prPromptNo() {
  closeModal('prPromptModal');
  _prPromptCb = null;
}

// ── Utilities ───────────────────────────────────────────────
function esc(s) { if(!s)return''; const d=document.createElement('div'); d.textContent=String(s); return d.innerHTML; }
function fmtDate(d) { if(!d)return'N/A'; return new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}); }
// Date + 24-hour time, e.g. "Jun 7, 2026 14:30" — used for audit log timestamps.
function fmtDateTime(d) {
  if(!d) return 'N/A';
  const dt = new Date(d);
  const date = dt.toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'});
  const time = dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});
  return `${date} ${time}`;
}

/* ══════════════════════════════════════════════════════════
   ASSESSMENT DATA STEP — measures, pre-employment tests, dates
   ══════════════════════════════════════════════════════════ */

const PREEMP_TESTS = [
  'MAS Mental Ability Test',
  'Purdue Non-Language Test',
  'Differential Aptitude Test - Fifth Edition',
  'BarOn EQ Inventory: Short Version',
  'Masaklaw na Panukat ng Loob',
  'Basic Personality Inventory',
  'House-Tree-Person Test',
  'Sacks Sentence Completion Test',
  'Mental Status Exam',
];

function currentTemplateType() {
  const t = allTemplates.find(t => t.id === selectedTemplateId);
  return t ? t.template_type : null;
}

// Render the Assessment Data step according to the selected template type.
function renderAssessmentStep() {
  const type = currentTemplateType();
  const isPreEmp = type === 'pre_employment';

  const preemp = document.getElementById('preempBlock');
  if (preemp) preemp.classList.toggle('hidden', !isPreEmp);

  if (isPreEmp) {
    const tbody = document.querySelector('#preempTable tbody');
    if (tbody && !tbody.dataset.built) {
      tbody.innerHTML = PREEMP_TESTS.map((name, i) => `
        <tr>
          <td>${esc(name)}</td>
          <td>
            <div class="date-field" data-idx="${i}">
              <input type="text" class="form-control date-input" id="pe-date-${i}" readonly placeholder="Select date" onclick="openCalendar(this)">
              <input type="hidden" id="pe-dateval-${i}">
            </div>
          </td>
        </tr>`).join('');
      tbody.dataset.built = '1';
    }
  }
}

/* ── Shared calendar popover ─────────────────────────────────
   maxDate: when set, days after maxDate are rendered disabled.
   afterPick: name of a global function to call after a date is picked
              (used by battery rows in the section editor).
   valTarget lookup: checks data-val-id attribute first, then falls
              back to the legacy pe-dateval-N pattern.
   ──────────────────────────────────────────────────────────── */
const _cal = { date: new Date(), target: null, valTarget: null, maxDate: null, afterPick: null };

function openCalendar(inputEl) {
  _cal.target = inputEl;

  // Resolve the hidden ISO value input
  if (inputEl.dataset.valId) {
    _cal.valTarget = document.getElementById(inputEl.dataset.valId);
  } else {
    const idx = inputEl.id.replace('pe-date-', '');
    _cal.valTarget = document.getElementById('pe-dateval-' + idx);
  }

  // All date pickers on this page are for past/present dates (administered dates)
  _cal.maxDate = new Date();
  _cal.maxDate.setHours(23, 59, 59, 999);

  // Optional callback to invoke after picking (e.g. auto-save battery section)
  _cal.afterPick = inputEl.dataset.afterPick || null;

  const pop = document.getElementById('calPop');
  const r = inputEl.getBoundingClientRect();
  pop.style.top = (window.scrollY + r.bottom + 6) + 'px';
  pop.style.left = Math.min(window.scrollX + r.left, window.innerWidth - 270) + 'px';

  const existing = (_cal.valTarget && _cal.valTarget.value)
    ? new Date(_cal.valTarget.value + 'T00:00:00')
    : new Date();
  _cal.date = new Date(existing.getFullYear(), existing.getMonth(), 1);
  renderCalendar();
  pop.classList.add('show');
  setTimeout(() => document.addEventListener('click', _calOutside), 0);
}

function _calOutside(e) {
  const pop = document.getElementById('calPop');
  if (!pop.contains(e.target) && e.target !== _cal.target) closeCalendar();
}

function closeCalendar() {
  document.getElementById('calPop').classList.remove('show');
  document.removeEventListener('click', _calOutside);
}

function renderCalendar() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const y = _cal.date.getFullYear(), m = _cal.date.getMonth();
  document.getElementById('calTitle').textContent = `${months[m]} ${y}`;
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  let html = '';
  for (let i = 0; i < first; i++) html += '<span class="cal-pop__day cal-pop__day--empty"></span>';
  for (let d = 1; d <= days; d++) {
    const isFuture = _cal.maxDate && new Date(y, m, d) > _cal.maxDate;
    if (isFuture) {
      html += `<span class="cal-pop__day cal-pop__day--disabled">${d}</span>`;
    } else {
      html += `<span class="cal-pop__day" onclick="pickDate(${y},${m},${d})">${d}</span>`;
    }
  }
  document.getElementById('calGrid').innerHTML = html;
}

function pickDate(y, m, d) {
  const dt = new Date(y, m, d);
  if (_cal.maxDate && dt > _cal.maxDate) return;
  const readable = dt.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const iso = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  if (_cal.target) _cal.target.value = readable;
  if (_cal.valTarget) _cal.valTarget.value = iso;
  closeCalendar();
  if (_cal.afterPick && typeof window[_cal.afterPick] === 'function') window[_cal.afterPick]();
}

// Wire calendar nav once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const prev = document.getElementById('calPrev');
  const next = document.getElementById('calNext');
  if (prev) prev.addEventListener('click', (e) => { e.stopPropagation(); _cal.date.setMonth(_cal.date.getMonth() - 1); renderCalendar(); });
  if (next) next.addEventListener('click', (e) => { e.stopPropagation(); _cal.date.setMonth(_cal.date.getMonth() + 1); renderCalendar(); });
});

// Collect pre-employment tests + dates from the table.
function collectPreempTests() {
  return PREEMP_TESTS.map((name, i) => {
    const dispEl = document.getElementById('pe-date-' + i);
    return { name, date: dispEl ? dispEl.value.trim() : '' };
  });
}