/**
 * BPS Calendar Widget — Reusable Date+Time Picker
 * ─────────────────────────────────────────────────
 * Usage:
 *   <link rel="stylesheet" href="intakeform.css">  (contains .cal-* styles)
 *   <script src="bps-calendar.js"></script>
 *
 *   const cal = BPSCalendar.mount('#my-container', {
 *     bookedDates: ['2026-05-20', '2026-05-22'],
 *     onChange: (isoString) => { console.log('Selected:', isoString); },
 *     minDate: new Date(),          // default: today
 *     showTime: true,               // default: true
 *     apiBase: '/api',  // enables real-time availability
 *     token: 'Bearer ...',          // auth token for API calls
 *   });
 *
 *   cal.setBookedDates(['2026-05-20']);
 *   cal.getValue();   // '2026-05-20T14:00'
 *   cal.destroy();
 */
(function () {
  'use strict';

  const MONTHS = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];

  // 1-hour intervals only (9 AM – 5 PM)
  const TIME_SLOTS = [
    { v:'09:00', l:'9:00 AM' },
    { v:'10:00', l:'10:00 AM' },
    { v:'11:00', l:'11:00 AM' },
    { v:'12:00', l:'12:00 PM' },
    { v:'13:00', l:'1:00 PM' },
    { v:'14:00', l:'2:00 PM' },
    { v:'15:00', l:'3:00 PM' },
    { v:'16:00', l:'4:00 PM' },
    { v:'17:00', l:'5:00 PM' },
  ];

  const MAX_DAILY = 5;

  /**
   * Mount a calendar into a container element.
   * @param {string|HTMLElement} container - CSS selector or DOM element.
   * @param {object} [opts] - Configuration options.
   * @returns {object} Calendar instance with methods.
   */
  function mount(container, opts = {}) {
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    if (!el) { console.error('BPSCalendar: container not found:', container); return null; }

    const showTime = opts.showTime !== false;
    const onChange = opts.onChange || function() {};
    const minDate = opts.minDate || new Date();
    minDate.setHours(0, 0, 0, 0);

    // Optional upper bound — e.g. a "Date of Assessment" that cannot be in the
    // future. Days after maxDate are disabled and the Next arrow stops there.
    const maxDate = opts.maxDate ? new Date(opts.maxDate) : null;
    if (maxDate) maxDate.setHours(0, 0, 0, 0);

    const apiBase = opts.apiBase || '';
    const token = opts.token || '';

    // Specific date+time combinations to remove from the time picker — e.g. an
    // appointment's current/proposed schedule during a reschedule, so the client
    // cannot re-select the same slot. Each entry is normalised to local
    // 'YYYY-MM-DDTHH:MM' for comparison against the selected date + slot.
    const normalizeDT = (val) => {
      const d = new Date(val);
      if (isNaN(d)) return '';
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    };
    const excludedSlots = new Set((opts.excludedSlots || []).map(normalizeDT).filter(Boolean));

    // Initial month to display. Defaults to minDate, but callers can open the
    // calendar on a different month (e.g. today, when minDate is far in the past).
    const startView = opts.startDate ? new Date(opts.startDate) : (maxDate || minDate);
    let viewYear = startView.getFullYear();
    let viewMonth = startView.getMonth();
    let selectedDate = null;
    let bookedDates = new Set(opts.bookedDates || []);
    let fullDates = new Set();       // dates that have reached 5/5
    let currentBookedSlots = [];     // booked time slots for selected date
    let currentAvailability = null;  // availability data for selected date

    // ── Build DOM ──
    const uid = 'bpscal-' + Math.random().toString(36).substring(2, 8);
    el.innerHTML = `
      <div class="cal-widget" id="${uid}">
        <div class="cal-header">
          <button type="button" class="cal-nav" id="${uid}-prev" title="Previous month">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" fill="currentColor"/></svg>
          </button>
          <div class="cal-title" id="${uid}-title"></div>
          <button type="button" class="cal-nav" id="${uid}-next" title="Next month">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" fill="currentColor"/></svg>
          </button>
        </div>
        <div class="cal-weekdays">
          <span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span>
        </div>
        <div class="cal-grid" id="${uid}-grid"></div>
        ${showTime ? `
        <div class="cal-time-row">
          <label for="${uid}-time">Time:</label>
          <select id="${uid}-time">
            <option value="">Select a date first</option>
          </select>
        </div>` : ''}
        <div class="cal-availability" id="${uid}-avail"></div>
        <div class="cal-selected" id="${uid}-sel">No date selected</div>
      </div>
    `;

    const grid = document.getElementById(`${uid}-grid`);
    const titleEl = document.getElementById(`${uid}-title`);
    const prevBtn = document.getElementById(`${uid}-prev`);
    const nextBtn = document.getElementById(`${uid}-next`);
    const selLabel = document.getElementById(`${uid}-sel`);
    const availEl = document.getElementById(`${uid}-avail`);
    const timeSelect = showTime ? document.getElementById(`${uid}-time`) : null;

    // ── Fetch availability for a specific date ──
    async function fetchAvailability(dateStr) {
      if (!apiBase) return null;
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = token.startsWith('Bearer') ? token : `Bearer ${token}`;
        const res = await fetch(`${apiBase}/appointments/availability?date=${dateStr}`, { headers });
        const json = await res.json();
        if (json.success) return json.data;
      } catch (err) { console.error('BPSCalendar: availability fetch failed', err); }
      return null;
    }

    // Is the given slot ('HH:MM') already in the past for the selected date?
    // Only applies when the selected date is the current calendar day — earlier
    // days are fully blocked and later days are always in the future.
    function isPastSlot(slotValue) {
      if (!selectedDate) return false;
      const now = new Date();
      const sameDay =
        selectedDate.getFullYear() === now.getFullYear() &&
        selectedDate.getMonth() === now.getMonth() &&
        selectedDate.getDate() === now.getDate();
      if (!sameDay) return false;
      const [h, m] = slotValue.split(':').map(Number);
      const slotDt = new Date(now);
      slotDt.setHours(h, m, 0, 0);
      return slotDt <= now;
    }

    // ── Update time select based on availability ──
    function updateTimeSlots(bookedSlotsList) {
      if (!timeSelect) return;
      const currentVal = timeSelect.value;
      const selDateStr = selectedDate
        ? `${selectedDate.getFullYear()}-${String(selectedDate.getMonth()+1).padStart(2,'0')}-${String(selectedDate.getDate()).padStart(2,'0')}`
        : '';
      const isExcludedSlot = (slot) => selDateStr && excludedSlots.has(`${selDateStr}T${slot}`);
      timeSelect.innerHTML = '<option value="">Select time</option>';
      TIME_SLOTS.forEach(t => {
        const isBooked = bookedSlotsList.includes(t.v);
        const isPast = isPastSlot(t.v);
        const isExcluded = isExcludedSlot(t.v);
        const opt = document.createElement('option');
        opt.value = t.v;
        opt.textContent = isExcluded ? `${t.l} — Current schedule`
          : isPast ? `${t.l} — Unavailable`
          : isBooked ? `${t.l} — Booked` : t.l;
        opt.disabled = isBooked || isPast || isExcluded;
        if (isBooked || isPast || isExcluded) opt.style.color = '#a0aec0';
        timeSelect.appendChild(opt);
      });
      // Restore previous selection only if it is still available (not booked, past, or excluded).
      if (currentVal && !bookedSlotsList.includes(currentVal) && !isPastSlot(currentVal) && !isExcludedSlot(currentVal)) {
        timeSelect.value = currentVal;
      } else {
        timeSelect.value = '';
      }
    }

    // ── Show availability indicator ──
    function showAvailability(data) {
      if (!data || !availEl) return;
      const remaining = MAX_DAILY - data.count;
      let cls = 'cal-availability';
      if (remaining <= 1) cls += ' cal-availability--low';
      else if (remaining <= 2) cls += ' cal-availability--medium';
      else cls += ' cal-availability--good';

      availEl.className = cls;
      availEl.style.display = 'flex';
      availEl.innerHTML = `<span class="cal-avail-dot"></span> ${remaining} of ${MAX_DAILY} slots remaining`;
    }

    function hideAvailability() {
      if (availEl) { availEl.style.display = 'none'; }
    }

    // ── Handle date selection ──
    async function onDateSelected(dateStr) {
      const parts = dateStr.split('-');
      selectedDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      selectedDate.setHours(0, 0, 0, 0);

      // Fetch real-time availability if API is configured
      if (apiBase) {
        const data = await fetchAvailability(dateStr);
        if (data) {
          currentAvailability = data;
          currentBookedSlots = data.bookedSlots || [];
          updateTimeSlots(currentBookedSlots);
          showAvailability(data);

          if (data.isFull) {
            fullDates.add(dateStr);
            hideAvailability();
            selectedDate = null;
            render();
            return;
          }
        }
      } else {
        // No API — reset time slots
        currentBookedSlots = [];
        updateTimeSlots([]);
        hideAvailability();
      }

      updateLabel();
      render();
    }

    // ── Render ──
    function render() {
      titleEl.textContent = `${MONTHS[viewMonth]} ${viewYear}`;

      // Disable prev if at or before minDate month
      const isMinMonth = viewYear === minDate.getFullYear() && viewMonth === minDate.getMonth();
      const isBefore = viewYear < minDate.getFullYear() || (viewYear === minDate.getFullYear() && viewMonth < minDate.getMonth());
      prevBtn.disabled = isMinMonth || isBefore;

      // Disable next if at or after the maxDate month
      if (maxDate) {
        const isMaxMonth = viewYear === maxDate.getFullYear() && viewMonth === maxDate.getMonth();
        const isAfter = viewYear > maxDate.getFullYear() || (viewYear === maxDate.getFullYear() && viewMonth > maxDate.getMonth());
        nextBtn.disabled = isMaxMonth || isAfter;
      }

      const firstDay = new Date(viewYear, viewMonth, 1).getDay();
      const startOffset = (firstDay === 0) ? 6 : firstDay - 1;
      const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
      const daysInPrev = new Date(viewYear, viewMonth, 0).getDate();

      let html = '';

      // Previous month trailing
      for (let i = startOffset - 1; i >= 0; i--) {
        html += `<button type="button" class="cal-day cal-day--other" disabled>${daysInPrev - i}</button>`;
      }

      // Current month
      for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(viewYear, viewMonth, d);
        date.setHours(0, 0, 0, 0);
        const dateStr = `${viewYear}-${String(viewMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

        const isPast = date < minDate;
        const isFuture = maxDate && date > maxDate;
        const isToday = date.getTime() === new Date(new Date().setHours(0,0,0,0)).getTime();
        const isFull = fullDates.has(dateStr);
        const isBooked = bookedDates.has(dateStr);
        const isSelected = selectedDate && selectedDate.getTime() === date.getTime();

        let cls = 'cal-day';
        if (isToday) cls += ' cal-day--today';
        if (isSelected) cls += ' cal-day--selected';
        if (isPast || isFuture) cls += ' cal-day--disabled';
        else if (isFull) cls += ' cal-day--full';
        else if (isBooked) cls += ' cal-day--booked';

        const disabled = isPast || isFuture || isFull || isBooked;
        let title = '';
        if (isFull) title = 'Fully booked (5/5 clients)';
        else if (isBooked) title = 'This date is already booked';
        else if (isPast) title = 'Past date';
        else if (isFuture) title = 'Future date not allowed';

        html += `<button type="button" class="${cls}" data-date="${dateStr}" ${disabled ? 'disabled' : ''} ${title ? `title="${title}"` : ''}>${d}</button>`;
      }

      // Next month trailing
      const totalCells = startOffset + daysInMonth;
      const rem = (7 - (totalCells % 7)) % 7;
      for (let i = 1; i <= rem; i++) {
        html += `<button type="button" class="cal-day cal-day--other" disabled>${i}</button>`;
      }

      grid.innerHTML = html;

      // Click handlers
      grid.querySelectorAll('.cal-day:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
          onDateSelected(btn.dataset.date);
        });
      });
    }

    function getValue() {
      if (!selectedDate) return '';
      const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth()+1).padStart(2,'0')}-${String(selectedDate.getDate()).padStart(2,'0')}`;
      if (showTime && timeSelect) {
        return timeSelect.value ? `${dateStr}T${timeSelect.value}` : '';
      }
      return dateStr;
    }

    function updateLabel() {
      const time = showTime && timeSelect ? timeSelect.value : '';
      if (selectedDate && (!showTime || time)) {
        const val = getValue();
        const dt = new Date(showTime ? val : selectedDate);
        const dateLabel = dt.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const timeLabel = showTime ? ` at ${dt.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}` : '';
        selLabel.innerHTML = `Selected: <strong>${dateLabel}${timeLabel}</strong>`;
        onChange(val);
      } else if (selectedDate) {
        selLabel.innerHTML = `Date: <strong>${selectedDate.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</strong> — please select a time`;
      } else {
        selLabel.textContent = 'No date selected';
      }
    }

    prevBtn.addEventListener('click', () => {
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      render();
    });

    nextBtn.addEventListener('click', () => {
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      render();
    });

    if (timeSelect) {
      timeSelect.addEventListener('change', updateLabel);
    }

    render();

    // ── Public API ──
    return {
      getValue,
      getSelectedDate: () => selectedDate,
      setBookedDates(dates) {
        bookedDates = new Set(dates);
        render();
      },
      addBookedDates(dates) {
        dates.forEach(d => bookedDates.add(d));
        render();
      },
      setFullDates(dates) {
        fullDates = new Set(dates);
        render();
      },
      destroy() {
        el.innerHTML = '';
      },
    };
  }

  window.BPSCalendar = { mount };
})();
