/**
 * BPS Toast Notification System
 * ────────────────────────────────────────────────────
 * A global, reusable toast notification module.
 *
 * Usage:
 *   <link rel="stylesheet" href="toast.css">
 *   <script src="toast.js"></script>
 *
 *   BPSToast.success('Form submitted successfully!');
 *   BPSToast.error('Something went wrong.');
 *   BPSToast.warning('Please review your input.');
 *   BPSToast.info('Your session will expire in 5 minutes.');
 */
(function () {
  'use strict';

  const DEFAULT_DURATION = 4000; // ms
  const MAX_TOASTS = 5;

  // SVG icons for each type
  const ICONS = {
    success: '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>',
    error:   '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>',
    warning: '<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
    info:    '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>',
  };

  const TITLES = {
    success: 'Success',
    error:   'Error',
    warning: 'Warning',
    info:    'Info',
  };

  let container = null;

  /**
   * Ensure the toast container exists in the DOM.
   */
  function ensureContainer() {
    if (container && document.body.contains(container)) return;
    container = document.createElement('div');
    container.className = 'bps-toast-container';
    container.id = 'bps-toast-container';
    document.body.appendChild(container);
  }

  /**
   * Remove excess toasts if we exceed the max.
   */
  function pruneToasts() {
    const toasts = container.querySelectorAll('.bps-toast:not(.bps-toast--removing)');
    if (toasts.length > MAX_TOASTS) {
      // Remove the oldest (first) toasts
      for (let i = 0; i < toasts.length - MAX_TOASTS; i++) {
        dismissToast(toasts[i]);
      }
    }
  }

  /**
   * Dismiss a toast with animation.
   */
  function dismissToast(el) {
    if (!el || el.classList.contains('bps-toast--removing')) return;
    el.classList.add('bps-toast--removing');
    el.addEventListener('animationend', () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, { once: true });
    // Fallback removal in case animation doesn't fire
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 400);
  }

  /**
   * Show a toast notification.
   * @param {string} message - The message to display.
   * @param {'success'|'error'|'warning'|'info'} type - Toast type.
   * @param {object} [options] - Optional overrides.
   * @param {string}  [options.title]    - Custom title (defaults to type name).
   * @param {number}  [options.duration] - Auto-dismiss duration in ms (0 = no auto-dismiss).
   */
  function show(message, type = 'info', options = {}) {
    ensureContainer();

    const title = options.title || TITLES[type] || TITLES.info;
    const duration = options.duration !== undefined ? options.duration : DEFAULT_DURATION;

    // Build toast element
    const toast = document.createElement('div');
    toast.className = `bps-toast bps-toast--${type}`;
    toast.innerHTML = `
      <a class="bps-toast__link" href="notifications.html" title="View in Notifications">
        <div class="bps-toast__icon">${ICONS[type] || ICONS.info}</div>
        <div class="bps-toast__body">
          <div class="bps-toast__title">${escHtml(title)}</div>
          <div class="bps-toast__message">${escHtml(message)}</div>
          <div class="bps-toast__hint">
            View in Notifications
            <svg viewBox="0 0 24 24"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
          </div>
        </div>
      </a>
      <button class="bps-toast__close" title="Dismiss">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
      </button>
      ${duration > 0 ? `<div class="bps-toast__progress" style="animation-duration:${duration}ms;"></div>` : ''}
    `;

    // Close button handler — prevent navigation and dismiss
    toast.querySelector('.bps-toast__close').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissToast(toast);
    });

    // Pause auto-dismiss on hover
    let autoTimer = null;
    if (duration > 0) {
      autoTimer = setTimeout(() => dismissToast(toast), duration);

      toast.addEventListener('mouseenter', () => {
        clearTimeout(autoTimer);
      });

      toast.addEventListener('mouseleave', () => {
        // Restart timer with remaining-ish time (simplified: give half duration)
        autoTimer = setTimeout(() => dismissToast(toast), duration / 2);
      });
    }

    container.appendChild(toast);
    pruneToasts();
  }

  /**
   * Escape HTML to prevent XSS in toast content.
   */
  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ── Public API ──────────────────────────────────────
  window.BPSToast = {
    show,
    success: (msg, opts) => show(msg, 'success', opts),
    error:   (msg, opts) => show(msg, 'error', opts),
    warning: (msg, opts) => show(msg, 'warning', opts),
    info:    (msg, opts) => show(msg, 'info', opts),
  };
})();
