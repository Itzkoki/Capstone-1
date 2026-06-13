/* ============================================================
   landing-content.js
   Public landing-page hydrator for Barcarse Psychological Services.

   Pulls saved content from  GET /api/landing/public  (no auth) and
   updates the hardcoded landing page in place: section text, cards,
   values, goals, stats, features, contacts, CTA buttons, the team
   carousel, plus section ordering and visibility.

   It is intentionally defensive: every selector is null-checked, and
   if the API is unreachable the page simply keeps its hardcoded
   defaults (and the team carousel falls back to BPSCarousel.DEFAULTS).
   ============================================================ */
(function () {
  'use strict';

  var API = 'http://localhost:5000/api/landing/public';
  // Backend origin used to resolve uploaded image paths (/uploads/team/...).
  var ASSET_BASE = API.replace(/\/api\/.*$/, '');
  function resolveAsset(p) {
    if (!p) return p;
    if (/^(https?:|data:)/i.test(p)) return p;
    return ASSET_BASE + p;
  }

  /* default inline icons used when the editor adds MORE cards/features
     than the original page shipped with (so new ones aren't iconless) */
  var DEFAULT_SERVICE_ICON =
    '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm0-4h-2V7h2v8z"/></svg>';
  var DEFAULT_FEATURE_ICON =
    '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';

  /* ---------- tiny helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function sectionEl(key) { return document.querySelector('[data-ls="' + key + '"]'); }

  function setText(el, value) {
    if (el && typeof value === 'string' && value.length) el.textContent = value;
  }

  /* set text but honour newlines as <br> (used for the hero headline) */
  function setMultiline(el, value) {
    if (!el || typeof value !== 'string' || !value.length) return;
    var parts = value.split(/\r?\n/);
    el.innerHTML = '';
    parts.forEach(function (line, i) {
      if (i > 0) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(line));
    });
  }

  /* replace the trailing text of an element while keeping a leading <svg> */
  function setTrailingText(el, value) {
    if (!el || typeof value !== 'string' || !value.length) return;
    var svg = el.querySelector('svg');
    el.textContent = '';
    if (svg) el.appendChild(svg);
    el.appendChild(document.createTextNode(value));
  }

  /* ---------- per-section hydrators ---------- */

  function hydrateHero(c) {
    var s = sectionEl('hero'); if (!s || !c) return;
    setMultiline($('.hero__headline', s), c.headline);
    setText($('.hero__description', s), c.description);
  }

  function hydrateHeader(s, c) {
    if (!s || !c) return;
    setText($('.section-label', s), c.label);
    setText($('.section-heading', s), c.heading);
    setText($('.section-subheading', s), c.subheading);
  }

  function hydrateServices(c) {
    var s = sectionEl('services'); if (!s || !c) return;
    hydrateHeader(s, c);
    var grid = $('.services__grid', s);
    if (!grid || !Array.isArray(c.cards)) return;
    var cards = $all('.service-card', grid);
    var template = cards[0];

    c.cards.forEach(function (data, i) {
      var card = cards[i];
      if (!card && template) {
        card = template.cloneNode(true);
        var ic = $('.service-card__icon', card);
        if (ic) ic.innerHTML = DEFAULT_SERVICE_ICON;
        grid.appendChild(card);
      }
      if (!card) return;
      setText($('.service-card__title', card), data.title);
      setText($('.service-card__text', card), data.text);
    });
    /* drop any leftover hardcoded cards beyond the saved count */
    cards.slice(c.cards.length).forEach(function (extra) {
      if (extra && extra.parentNode) extra.parentNode.removeChild(extra);
    });
  }

  function hydrateTeamHeader(c) {
    var s = sectionEl('team'); if (!s || !c) return;
    hydrateHeader($('.team-head', s) || s, c);
  }

  function hydrateMissionVision(c) {
    var s = sectionEl('mission_vision'); if (!s || !c) return;
    /* the label/heading/subheading live in the first .container */
    hydrateHeader($('.container', s) || s, c);

    var mvCards = $all('.mv-card', s);
    var vision = mvCards[0];
    var mission = mvCards[1];

    if (vision) {
      setText($('.mv-card__title', vision), c.vision_title);
      setText($('.mv-card__text', vision), c.vision_text);
      var pills = $('.mv-values', vision);
      if (pills && Array.isArray(c.values)) {
        pills.innerHTML = '';
        c.values.forEach(function (v) {
          var span = document.createElement('span');
          span.className = 'mv-values__pill';
          span.textContent = v;
          pills.appendChild(span);
        });
      }
    }

    if (mission) {
      setText($('.mv-card__title', mission), c.mission_title);
      setText($('.mv-card__text', mission), c.mission_text);
      var goals = $('.mv-card__goals', mission);
      if (goals && Array.isArray(c.goals)) {
        goals.innerHTML = '';
        c.goals.forEach(function (g) {
          var li = document.createElement('li');
          li.textContent = g;
          goals.appendChild(li);
        });
      }
    }

    setText($('.mv-history__title', s), c.history_title);
    setText($('.mv-history__text', s), c.history_text);

    var contacts = $all('.mv-contact__item', s);
    setTrailingText(contacts[0], c.contact_email);
    setTrailingText(contacts[1], c.contact_phone);
    setTrailingText(contacts[2], c.contact_phone2);
  }

  function hydrateAbout(c) {
    var s = sectionEl('about'); if (!s || !c) return;
    var head = $('.about__grid > div', s) || s;
    hydrateHeader(head, c);

    /* stats */
    var statsWrap = $('.about__stats', s);
    if (statsWrap && Array.isArray(c.stats)) {
      var statCards = $all('.stat-card', statsWrap);
      var statTpl = statCards[0];
      c.stats.forEach(function (data, i) {
        var card = statCards[i];
        if (!card && statTpl) { card = statTpl.cloneNode(true); statsWrap.appendChild(card); }
        if (!card) return;
        setText($('.stat-card__number', card), data.number);
        setText($('.stat-card__label', card), data.label);
      });
      statCards.slice(c.stats.length).forEach(function (x) {
        if (x && x.parentNode) x.parentNode.removeChild(x);
      });
    }

    /* features */
    var featWrap = $('.about__features', s);
    if (featWrap && Array.isArray(c.features)) {
      var featItems = $all('.feature-item', featWrap);
      var featTpl = featItems[0];
      c.features.forEach(function (data, i) {
        var item = featItems[i];
        if (!item && featTpl) {
          item = featTpl.cloneNode(true);
          var ic = $('.feature-item__icon', item);
          if (ic) ic.innerHTML = DEFAULT_FEATURE_ICON;
          featWrap.appendChild(item);
        }
        if (!item) return;
        setText($('.feature-item__title', item), data.title);
        setText($('.feature-item__text', item), data.text);
      });
      featItems.slice(c.features.length).forEach(function (x) {
        if (x && x.parentNode) x.parentNode.removeChild(x);
      });
    }
  }

  function hydrateCta(c) {
    var s = sectionEl('cta'); if (!s || !c) return;
    hydrateHeader(s, c);
    setText($('#cta-book', s), c.primary_label);
    setText($('#cta-contact', s), c.secondary_label);
  }

  /* ---------- ordering + visibility ---------- */
  function applyOrderAndVisibility(sections) {
    if (!Array.isArray(sections) || !sections.length) return;
    var footer = document.getElementById('footer');
    if (!footer || !footer.parentNode) return;
    var parent = footer.parentNode;

    var visibleKeys = {};
    sections.forEach(function (s) { visibleKeys[s.section_key] = true; });

    /* hide any managed section that is not in the visible list */
    $all('[data-ls]').forEach(function (el) {
      var key = el.getAttribute('data-ls');
      if (!visibleKeys[key]) el.style.display = 'none';
    });

    /* re-insert visible sections, in saved order, just before the footer */
    sections.forEach(function (s) {
      var el = sectionEl(s.section_key);
      if (el) {
        el.style.display = '';
        parent.insertBefore(el, footer);
      }
    });
  }

  /* ---------- main ---------- */
  function hydrate(data) {
    var content = (data && data.content) || {};
    try { hydrateHero(content.hero); } catch (e) {}
    try { hydrateServices(content.services); } catch (e) {}
    try { hydrateTeamHeader(content.team); } catch (e) {}
    try { hydrateMissionVision(content.mission_vision); } catch (e) {}
    try { hydrateAbout(content.about); } catch (e) {}
    try { hydrateCta(content.cta); } catch (e) {}
    try { applyOrderAndVisibility(data && data.sections); } catch (e) {}

    /* team carousel from saved members (falls back to defaults if empty) */
    try {
      if (window.BPSCarousel && typeof window.BPSCarousel.build === 'function') {
        var team = (data && Array.isArray(data.team) && data.team.length)
          ? data.team.map(function (m) {
              /* DB stores only the file path; resolve it against the backend
                 origin so the <img> loads regardless of where the page is served. */
              return Object.assign({}, m, {
                photo_thumbnail: resolveAsset(m.photo_thumbnail),
                photo_full: resolveAsset(m.photo_full),
              });
            })
          : window.BPSCarousel.DEFAULTS;
        window.BPSCarousel.build(team);
      }
    } catch (e) {}
  }

  function fallbackCarousel() {
    try {
      if (window.BPSCarousel && typeof window.BPSCarousel.build === 'function' && !window.__bpsTeamBuilt) {
        window.BPSCarousel.build(window.BPSCarousel.DEFAULTS);
      }
    } catch (e) {}
  }

  function init() {
    fetch(API, { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (json) { hydrate((json && json.data) || json || {}); })
      .catch(function () { fallbackCarousel(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
