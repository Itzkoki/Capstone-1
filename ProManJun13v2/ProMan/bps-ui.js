/**
 * BPS UI Kit — system Modal + Dropdown + Date picker.
 * ─────────────────────────────────────────────────────────────
 * Replaces native window.confirm/alert/prompt, native <select>,
 * and native <input type=date|datetime-local>.
 *
 *   <link rel="stylesheet" href="bps-ui.css">
 *   <script src="bps-ui.js"></script>
 *
 * Modals (promise-based):
 *   await BPSModal.confirm('Delete this item?')            -> boolean
 *   await BPSModal.confirm('Reject?', {danger:true, confirmText:'Reject'})
 *   await BPSModal.alert('Saved.')                          -> void
 *   await BPSModal.prompt('New name?', {defaultValue:'x'})  -> string | null
 *
 * Dropdowns & dates auto-enhance every <select> and date input on
 * the page (and any added later). Opt out with data-bps-skip.
 * The original element stays in the DOM (hidden) so existing
 * `.value` reads, form posts, and `change`/`input` listeners keep
 * working unchanged. Call BPSUI.enhanceAll() after injecting markup.
 */
(function () {
  'use strict';

  /* ============================ helpers ============================ */
  const SVG = {
    caret: '<svg class="bui-select__caret" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>',
    check: '<svg class="bui-check" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
    cal: '<svg class="bui-date__ico" viewBox="0 0 24 24"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z"/></svg>',
    clear: '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
    info: '<svg viewBox="0 0 24 24"><path d="M11 9h2V7h-2m1 13c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8m0-18C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m-1 15h2v-6h-2v6z"/></svg>',
  };
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DOW = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  function pad(n){ return String(n).padStart(2, '0'); }

  /* ============================ MODAL ============================ */
  const BPSModal = (function () {
    let openCount = 0;

    function build({ kind, title, message, confirmText, cancelText, danger, defaultValue, placeholder }) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'bui-modal' + (danger ? ' bui-modal--danger' : '');
        const isPrompt = kind === 'prompt';
        const isAlert = kind === 'alert';
        const icon = danger ? SVG.warn : (isAlert ? SVG.info : SVG.warn);
        overlay.innerHTML =
          '<div class="bui-modal__box" role="dialog" aria-modal="true">' +
            '<div class="bui-modal__icon">' + icon + '</div>' +
            (title ? '<h3 class="bui-modal__title"></h3>' : '') +
            '<p class="bui-modal__msg"></p>' +
            (isPrompt ? '<input class="bui-modal__input" type="text">' : '') +
            '<div class="bui-modal__actions">' +
              (isAlert ? '' : '<button class="bui-btn bui-btn--ghost" data-act="cancel"></button>') +
              '<button class="bui-btn ' + (danger ? 'bui-btn--danger' : 'bui-btn--primary') + '" data-act="ok"></button>' +
            '</div>' +
          '</div>';
        if (title) overlay.querySelector('.bui-modal__title').textContent = title;
        overlay.querySelector('.bui-modal__msg').textContent = message || '';
        const okBtn = overlay.querySelector('[data-act="ok"]');
        const cancelBtn = overlay.querySelector('[data-act="cancel"]');
        okBtn.textContent = confirmText || (isAlert ? 'OK' : (isPrompt ? 'Save' : 'Confirm'));
        if (cancelBtn) cancelBtn.textContent = cancelText || 'Cancel';
        const input = overlay.querySelector('.bui-modal__input');
        if (input) { input.value = defaultValue || ''; if (placeholder) input.placeholder = placeholder; }

        document.body.appendChild(overlay);
        openCount++;
        document.body.style.overflow = 'hidden';
        requestAnimationFrame(() => overlay.classList.add('is-open'));

        function close(result) {
          overlay.classList.remove('is-open');
          document.removeEventListener('keydown', onKey, true);
          setTimeout(() => {
            overlay.remove();
            if (--openCount <= 0) { openCount = 0; document.body.style.overflow = ''; }
            resolve(result);
          }, 160);
        }
        function onKey(e) {
          if (e.key === 'Escape') { e.preventDefault(); close(isPrompt ? null : (isAlert ? undefined : false)); }
          else if (e.key === 'Enter' && (!input || document.activeElement === input || document.activeElement === okBtn)) {
            e.preventDefault(); confirmResult();
          }
        }
        function confirmResult() { close(isPrompt ? input.value : (isAlert ? undefined : true)); }

        okBtn.addEventListener('click', confirmResult);
        if (cancelBtn) cancelBtn.addEventListener('click', () => close(isPrompt ? null : false));
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(isPrompt ? null : (isAlert ? undefined : false)); });
        document.addEventListener('keydown', onKey, true);
        setTimeout(() => { (input || okBtn).focus(); if (input) input.select(); }, 60);
      });
    }

    return {
      confirm: (message, opts = {}) => build({ kind: 'confirm', message, ...opts }),
      alert: (message, opts = {}) => build({ kind: 'alert', message, ...opts }),
      prompt: (message, opts = {}) => build({ kind: 'prompt', message, ...opts }),
    };
  })();

  /* ============================ SELECT ============================ */
  function enhanceSelect(sel) {
    if (sel.dataset.buiDone || sel.multiple || sel.size > 1 || sel.closest('.bui-cal__time')) return;
    if (sel.hasAttribute('data-bps-skip')) return;
    sel.dataset.buiDone = '1';

    const wrap = document.createElement('div');
    wrap.className = 'bui-select';
    if (sel.disabled) wrap.classList.add('is-disabled');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'bui-select__trigger';
    trigger.innerHTML = '<span class="bui-select__label"></span>' + SVG.caret;
    const menu = document.createElement('div');
    menu.className = 'bui-select__menu';
    wrap.appendChild(trigger);
    wrap.appendChild(menu);

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('bui-select__native');
    sel.tabIndex = -1;

    const label = trigger.querySelector('.bui-select__label');

    function renderMenu() {
      menu.innerHTML = '';
      Array.from(sel.children).forEach((node) => {
        if (node.tagName === 'OPTGROUP') {
          const g = document.createElement('div'); g.className = 'bui-select__group'; g.textContent = node.label; menu.appendChild(g);
          Array.from(node.children).forEach((o) => menu.appendChild(buildOpt(o)));
        } else if (node.tagName === 'OPTION') {
          menu.appendChild(buildOpt(node));
        }
      });
    }
    function buildOpt(o) {
      const el = document.createElement('div');
      el.className = 'bui-select__opt';
      if (o.disabled) el.classList.add('is-disabled');
      if (o.selected) el.classList.add('is-selected');
      el.dataset.value = o.value;
      el.innerHTML = '<span>' + (o.textContent || '&nbsp;') + '</span>' + SVG.check;
      if (!o.disabled) el.addEventListener('click', () => { pick(o.value); });
      return el;
    }
    function syncLabel() {
      const opt = sel.options[sel.selectedIndex];
      const txt = opt ? opt.textContent : '';
      const isPlaceholder = opt && (opt.value === '' || opt.disabled);
      label.textContent = txt || (sel.options[0] ? sel.options[0].textContent : '');
      label.classList.toggle('is-placeholder', !!isPlaceholder);
      menu.querySelectorAll('.bui-select__opt').forEach((el) =>
        el.classList.toggle('is-selected', el.dataset.value === sel.value));
    }
    function pick(value) {
      if (sel.value !== value) {
        sel.value = value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncLabel();
      close();
    }
    function open() {
      if (sel.disabled) return;
      syncLabel(); // reflect any programmatic value change since last open
      document.querySelectorAll('.bui-select.is-open').forEach((s) => s !== wrap && s.classList.remove('is-open'));
      wrap.classList.add('is-open');
      const rect = wrap.getBoundingClientRect();
      wrap.classList.toggle('drop-up', rect.bottom + 270 > window.innerHeight && rect.top > 270);
      const cur = menu.querySelector('.bui-select__opt.is-selected') || menu.querySelector('.bui-select__opt');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    }
    function close() { wrap.classList.remove('is-open'); }

    trigger.addEventListener('click', (e) => { e.stopPropagation(); wrap.classList.contains('is-open') ? close() : open(); });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      else if (e.key === 'Escape') close();
    });
    // keep custom UI in sync if app code changes the select programmatically
    sel.addEventListener('change', syncLabel);
    sel._buiRefresh = () => { renderMenu(); syncLabel(); wrap.classList.toggle('is-disabled', sel.disabled); };
    // re-render when app code repopulates options or toggles disabled
    const mo = new MutationObserver(() => { renderMenu(); syncLabel(); wrap.classList.toggle('is-disabled', sel.disabled); });
    mo.observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    renderMenu();
    syncLabel();
  }

  /* ============================ DATE ============================ */
  function enhanceDate(input) {
    if (input.dataset.buiDone || input.hasAttribute('data-bps-skip')) return;
    const withTime = input.type === 'datetime-local';
    input.dataset.buiDone = '1';

    const wrap = document.createElement('div');
    wrap.className = 'bui-date';
    if (input.disabled) wrap.classList.add('is-disabled');
    wrap.innerHTML =
      '<button type="button" class="bui-date__trigger">' + SVG.cal +
        '<span class="bui-date__text"></span>' +
        '<span class="bui-date__clear" title="Clear" style="display:none">' + SVG.clear + '</span>' +
      '</button>' +
      '<div class="bui-date__pop">' +
        '<div class="bui-cal__head">' +
          '<button type="button" class="bui-cal__nav" data-nav="-1">' + SVG.prev + '</button>' +
          '<button type="button" class="bui-cal__title"></button>' +
          '<button type="button" class="bui-cal__nav" data-nav="1">' + SVG.next + '</button>' +
        '</div>' +
        '<div class="bui-cal__dows"></div>' +
        '<div class="bui-cal__grid"></div>' +
        '<div class="bui-cal__panel"></div>' +
        (withTime ? '<div class="bui-cal__time"><label>Time</label><select class="bui-cal__hour" data-bps-skip></select></div>' : '') +
        '<div class="bui-cal__foot"><button type="button" data-foot="today">Today</button><button type="button" data-foot="clear">Clear</button></div>' +
      '</div>';

    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add('bui-select__native');
    input.tabIndex = -1;

    const trigger = wrap.querySelector('.bui-date__trigger');
    const textEl = wrap.querySelector('.bui-date__text');
    const clearBtn = wrap.querySelector('.bui-date__clear');
    const pop = wrap.querySelector('.bui-date__pop');
    const titleBtn = wrap.querySelector('.bui-cal__title');
    const dowsEl = wrap.querySelector('.bui-cal__dows');
    const gridEl = wrap.querySelector('.bui-cal__grid');
    const panelEl = wrap.querySelector('.bui-cal__panel');
    const hourSel = wrap.querySelector('.bui-cal__hour');
    dowsEl.innerHTML = DOW.map((d) => '<div class="bui-cal__dow">' + d + '</div>').join('');

    const minDate = input.min ? parseISO(input.min) : null;
    const maxDate = input.max ? parseISO(input.max) : null;
    let view = new Date(); view.setDate(1);
    let panelMode = null; // 'month' | 'year'

    if (hourSel) {
      let opts = '';
      for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 30) {
        const hr12 = ((h % 12) || 12), ap = h < 12 ? 'AM' : 'PM';
        opts += '<option value="' + pad(h) + ':' + pad(m) + '">' + hr12 + ':' + pad(m) + ' ' + ap + '</option>';
      }
      hourSel.innerHTML = opts;
      hourSel.addEventListener('change', () => { if (current()) commit(current()); });
    }

    function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
    function current() {
      if (!input.value) return null;
      const datePart = input.value.split('T')[0];
      const [y, m, d] = datePart.split('-').map(Number);
      if (!y) return null;
      return new Date(y, m - 1, d);
    }
    function disabled(d) {
      if (minDate && d < minDate) return true;
      if (maxDate && d > maxDate) return true;
      return false;
    }
    function fmt(d) {
      const base = MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate() + ', ' + d.getFullYear();
      if (!withTime) return base;
      const t = (input.value.split('T')[1] || hourSel.value || '00:00');
      const [hh, mm] = t.split(':').map(Number);
      const hr12 = ((hh % 12) || 12), ap = hh < 12 ? 'AM' : 'PM';
      return base + ' · ' + hr12 + ':' + pad(mm) + ' ' + ap;
    }
    function syncText() {
      const c = current();
      if (c) { textEl.textContent = fmt(c); textEl.classList.remove('is-placeholder'); clearBtn.style.display = ''; }
      else { textEl.textContent = input.placeholder || 'Select date'; textEl.classList.add('is-placeholder'); clearBtn.style.display = 'none'; }
    }
    function commit(d) {
      let val = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      if (withTime) val += 'T' + (hourSel.value || '00:00');
      input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      syncText();
    }

    function renderGrid() {
      titleBtn.textContent = MONTHS[view.getMonth()] + ' ' + view.getFullYear();
      gridEl.innerHTML = '';
      const first = new Date(view.getFullYear(), view.getMonth(), 1);
      const start = new Date(first); start.setDate(1 - first.getDay());
      const sel = current(); const today = new Date(); today.setHours(0, 0, 0, 0);
      for (let i = 0; i < 42; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'bui-cal__day'; btn.textContent = d.getDate();
        if (d.getMonth() !== view.getMonth()) btn.classList.add('is-other');
        if (d.getTime() === today.getTime()) btn.classList.add('is-today');
        if (sel && d.toDateString() === sel.toDateString()) btn.classList.add('is-selected');
        if (disabled(d)) btn.disabled = true;
        else btn.addEventListener('click', () => { commit(d); if (!withTime) close(); });
        gridEl.appendChild(btn);
      }
    }
    function renderPanel() {
      panelEl.innerHTML = '';
      if (panelMode === 'month') {
        MONTHS.forEach((m, i) => {
          const c = document.createElement('button'); c.type = 'button'; c.className = 'bui-cal__cell';
          if (i === view.getMonth()) c.classList.add('is-selected'); c.textContent = m.slice(0, 3);
          c.addEventListener('click', () => { view.setMonth(i); panelMode = null; wrap.classList.remove('show-panel'); renderGrid(); });
          panelEl.appendChild(c);
        });
      } else {
        const base = view.getFullYear() - 7;
        for (let i = 0; i < 16; i++) {
          const y = base + i;
          const c = document.createElement('button'); c.type = 'button'; c.className = 'bui-cal__cell';
          if (y === view.getFullYear()) c.classList.add('is-selected'); c.textContent = y;
          c.addEventListener('click', () => { view.setFullYear(y); panelMode = 'month'; renderPanel(); });
          panelEl.appendChild(c);
        }
      }
    }
    function open() {
      if (input.disabled) return;
      document.querySelectorAll('.bui-date.is-open').forEach((d) => d !== wrap && d.classList.remove('is-open'));
      const c = current(); if (c) { view = new Date(c.getFullYear(), c.getMonth(), 1); if (withTime && input.value.includes('T')) hourSel.value = input.value.split('T')[1].slice(0, 5); }
      panelMode = null; wrap.classList.remove('show-panel');
      renderGrid();
      wrap.classList.add('is-open');
      const rect = wrap.getBoundingClientRect();
      wrap.classList.toggle('drop-up', rect.bottom + 360 > window.innerHeight && rect.top > 360);
    }
    function close() { wrap.classList.remove('is-open'); }

    trigger.addEventListener('click', (e) => {
      if (e.target.closest('.bui-date__clear')) { e.stopPropagation(); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); syncText(); return; }
      e.stopPropagation(); wrap.classList.contains('is-open') ? close() : open();
    });
    titleBtn.addEventListener('click', () => { panelMode = panelMode ? null : 'year'; wrap.classList.toggle('show-panel', !!panelMode); if (panelMode) renderPanel(); });
    wrap.querySelectorAll('.bui-cal__nav').forEach((b) => b.addEventListener('click', () => {
      if (panelMode === 'year') { view.setFullYear(view.getFullYear() + Number(b.dataset.nav) * 16); renderPanel(); }
      else { view.setMonth(view.getMonth() + Number(b.dataset.nav)); renderGrid(); }
    }));
    wrap.querySelector('[data-foot="today"]').addEventListener('click', () => { const t = new Date(); if (!disabled(t)) { view = new Date(t.getFullYear(), t.getMonth(), 1); commit(t); if (!withTime) close(); else renderGrid(); } });
    wrap.querySelector('[data-foot="clear"]').addEventListener('click', () => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); syncText(); close(); });
    input.addEventListener('change', syncText);
    input._buiRefresh = () => { wrap.classList.toggle('is-disabled', input.disabled); syncText(); };

    syncText();
  }

  /* ============================ wiring ============================ */
  function enhanceAll(root) {
    root = root || document;
    root.querySelectorAll('select:not([data-bui-done])').forEach(enhanceSelect);
    root.querySelectorAll('input[type="date"]:not([data-bui-done]), input[type="datetime-local"]:not([data-bui-done])').forEach(enhanceDate);
  }
  // close any open dropdown/datepicker when clicking elsewhere
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.bui-select')) document.querySelectorAll('.bui-select.is-open').forEach((s) => s.classList.remove('is-open'));
    if (!e.target.closest('.bui-date')) document.querySelectorAll('.bui-date.is-open').forEach((d) => d.classList.remove('is-open'));
  });

  function init() {
    enhanceAll(document);
    // pick up elements injected later (lists, modals rendered via innerHTML)
    const mo = new MutationObserver((muts) => {
      for (const m of muts) for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && (node.matches('select') || node.matches('input[type="date"]') || node.matches('input[type="datetime-local"]'))) {
          node.matches('select') ? enhanceSelect(node) : enhanceDate(node);
        }
        if (node.querySelectorAll) enhanceAll(node);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.BPSModal = BPSModal;
  window.BPSUI = { enhanceAll, enhanceSelect, enhanceDate };
})();
