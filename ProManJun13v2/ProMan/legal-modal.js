/**
 * Legal Modal — shared Privacy Policy & Terms of Service popups.
 * ─────────────────────────────────────────────────────────────
 * Include this script on any page, then mark a trigger with
 *   <a href="#" data-legal="privacy">Privacy Policy</a>
 *   <a href="#" data-legal="terms">Terms of Service</a>
 * Clicking the trigger opens an accessible centered modal with the
 * relevant content. No dependencies.
 */
(function () {
  'use strict';

  var CONTENT = {
    privacy: {
      title: 'Privacy Policy',
      html:
        '<p><strong>Barcarse Psychological Services</strong> respects your privacy and is committed to ' +
        'protecting the personal and clinical information you share with us, in accordance with the ' +
        'Philippine Data Privacy Act of 2012 (RA 10173).</p>' +
        '<h4>Information We Collect</h4>' +
        '<p>We collect the personal details you provide through our intake and assessment forms ' +
        '(such as your name, contact information, date of birth, and the concerns you wish to address), ' +
        'appointment and payment records, and the clinical notes and reports created during your care.</p>' +
        '<h4>How We Use Your Information</h4>' +
        '<p>Your information is used solely to deliver and coordinate your psychological services, ' +
        'schedule appointments, process payments, prepare reports, and communicate with you about your care. ' +
        'We do not sell your information or share it for marketing purposes.</p>' +
        '<h4>Data Protection</h4>' +
        '<p>Access to your records is restricted to authorized clinical staff on a need-to-know basis. ' +
        'Sensitive records are protected by role-based access controls, and all access is logged.</p>' +
        '<h4>Confidentiality</h4>' +
        '<p>All clinical information is treated as confidential. Disclosure to third parties occurs only ' +
        'with your written consent or when required by law (for example, where there is a risk of serious ' +
        'harm to yourself or others).</p>' +
        '<h4>Your Rights</h4>' +
        '<p>You have the right to access, correct, and request a copy of your personal data, and to ask ' +
        'questions about how it is handled. To exercise these rights, please contact our clinic directly.</p>'
    },
    terms: {
      title: 'Terms of Service',
      html:
        '<p>By using the services and online portal of <strong>Barcarse Psychological Services</strong>, ' +
        'you agree to the following terms.</p>' +
        '<h4>Use of Services</h4>' +
        '<p>Our portal is provided to help you request appointments, complete intake and assessment forms, ' +
        'make payments, and receive psychological services. You agree to provide accurate, complete, and ' +
        'truthful information so that we can deliver appropriate care.</p>' +
        '<h4>Appointments &amp; Payments</h4>' +
        '<p>Appointment slots are confirmed only after the required payment has been submitted and verified. ' +
        'Fees, schedules, and cancellation arrangements follow the clinic’s current policies, which may ' +
        'be updated from time to time.</p>' +
        '<h4>Professional Relationship</h4>' +
        '<p>Information provided through this portal does not replace a formal clinical consultation. ' +
        'Psychological services are rendered by licensed professionals, and any reports or recommendations ' +
        'are based on the information you provide and the assessments conducted.</p>' +
        '<h4>Acceptable Use</h4>' +
        '<p>You agree not to misuse the portal, attempt to gain unauthorized access, or upload harmful or ' +
        'unlawful content. Accounts are personal to you and must not be shared.</p>' +
        '<h4>Limitation of Liability</h4>' +
        '<p>While we strive to keep the portal available and accurate, services are provided on an ' +
        '"as available" basis. In an emergency, please contact local emergency services immediately rather ' +
        'than relying on this portal.</p>' +
        '<h4>Changes to These Terms</h4>' +
        '<p>We may update these terms periodically. Continued use of the portal after changes take effect ' +
        'constitutes acceptance of the revised terms.</p>'
    }
  };

  function ensureStyles() {
    if (document.getElementById('legal-modal-styles')) return;
    var css =
      '.legal-modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;' +
      'align-items:center;justify-content:center;z-index:10000;padding:20px;}' +
      '.legal-modal-overlay.open{display:flex;}' +
      '.legal-modal-box{background:#fff;border-radius:14px;max-width:640px;width:100%;max-height:85vh;' +
      'display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.3);overflow:hidden;' +
      'animation:legalPop .18s ease-out;}' +
      '@keyframes legalPop{from{transform:translateY(12px) scale(.98);opacity:0;}to{transform:none;opacity:1;}}' +
      '.legal-modal-head{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;' +
      'border-bottom:1px solid #e2e8f0;}' +
      '.legal-modal-head h3{margin:0;font-size:20px;color:#1E3A8A;font-weight:700;}' +
      '.legal-modal-close{background:none;border:none;font-size:26px;line-height:1;cursor:pointer;color:#64748b;' +
      'padding:0 4px;}' +
      '.legal-modal-close:hover{color:#1e293b;}' +
      '.legal-modal-body{padding:20px 24px 28px;overflow-y:auto;color:#334155;font-size:14.5px;line-height:1.65;}' +
      '.legal-modal-body h4{color:#1E3A8A;font-size:15px;margin:18px 0 6px;}' +
      '.legal-modal-body p{margin:0 0 10px;}';
    var style = document.createElement('style');
    style.id = 'legal-modal-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  var overlay, titleEl, bodyEl;

  function buildModal() {
    if (overlay) return;
    ensureStyles();
    overlay = document.createElement('div');
    overlay.className = 'legal-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<div class="legal-modal-box">' +
        '<div class="legal-modal-head">' +
          '<h3 id="legal-modal-title"></h3>' +
          '<button type="button" class="legal-modal-close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="legal-modal-body" id="legal-modal-body"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    titleEl = overlay.querySelector('#legal-modal-title');
    bodyEl = overlay.querySelector('#legal-modal-body');

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    overlay.querySelector('.legal-modal-close').addEventListener('click', closeModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
    });
  }

  function openModal(kind) {
    var data = CONTENT[kind];
    if (!data) return;
    buildModal();
    titleEl.textContent = data.title;
    bodyEl.innerHTML = data.html;
    bodyEl.scrollTop = 0;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    if (!overlay) return;
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  // Delegate clicks for any trigger marked with data-legal.
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-legal]');
    if (!trigger) return;
    e.preventDefault();
    openModal(trigger.getAttribute('data-legal'));
  });

  // Expose for programmatic use.
  window.openLegalModal = openModal;
})();
