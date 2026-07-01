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

  var API = '/api/landing/public';
  // Backend origin used to resolve uploaded image paths (/uploads/team/...).
  var ASSET_BASE = API.replace(/\/api\/.*$/, '');
  function resolveAsset(p) {
    if (!p) return p;
    if (/^(https?:|data:)/i.test(p)) return p;
    return ASSET_BASE + p;
  }

  /* default inline icon used when the editor adds MORE service cards
     than the original page shipped with (so new ones aren't iconless) */
  var DEFAULT_SERVICE_ICON =
    '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm0-4h-2V7h2v8z"/></svg>';

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

  /* fallback drawer icon for editor-added cards that have no baked-in icon */
  var DEFAULT_DRAWER_ICON_PATH =
    '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm0-4h-2V7h2v8z"/>';

  function hydrateServices(c) {
    var s = sectionEl('services'); if (!s || !c) return;
    hydrateHeader(s, c);
    var grid = $('.services__grid', s);
    if (!grid || !Array.isArray(c.cards)) return;
    var cards = $all('.service-card', grid);
    var template = cards[0];
    /* drawer content store created by landingpage's drawer script (same object
       the drawer reads); fall back to a fresh map if it ran in a different order */
    var store = window.BPS_SERVICES || (window.BPS_SERVICES = {});

    c.cards.forEach(function (data, i) {
      var card = cards[i];
      if (!card && template) {
        card = template.cloneNode(true);
        var ic = $('.service-card__icon', card);
        if (ic) ic.innerHTML = DEFAULT_SERVICE_ICON;
        card.removeAttribute('data-svc'); /* force a fresh key below */
        grid.appendChild(card);
      }
      if (!card) return;
      setText($('.service-card__title', card), data.title);
      setText($('.service-card__text', card), data.text);
      if (data.accent) card.setAttribute('data-accent', data.accent);

      /* stable key so the detail drawer can look this card up on click */
      var key = card.getAttribute('data-svc');
      if (!key) { key = 'svc-' + i; card.setAttribute('data-svc', key); }

      /* overlay the editable fields onto the drawer data (keep baked-in icon) */
      var d = store[key] || {};
      if (data.title)  d.title = data.title;
      if (data.accent) d.accent = data.accent;
      if (data.lead)   d.lead = data.lead;
      if (data.about)  d.about = data.about;
      if (Array.isArray(data.expect)   && data.expect.length)   d.expect = data.expect;
      if (Array.isArray(data.idealFor) && data.idealFor.length) d.idealFor = data.idealFor;
      if (Array.isArray(data.faqs)     && data.faqs.length)     d.faqs = data.faqs;
      if (!d.icon)     d.icon = DEFAULT_DRAWER_ICON_PATH;
      if (!d.accent)   d.accent = 'blue';
      if (!d.lead)     d.lead = data.text || '';
      if (!d.about)    d.about = '';
      if (!d.expect)   d.expect = [];
      if (!d.idealFor) d.idealFor = [];
      if (!d.faqs)     d.faqs = [];
      store[key] = d;
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

    /* keep the two-tone heading: Vision = blue, Mission = green */
    var headingEl = $('.section-heading', s);
    if (headingEl) {
      var h = (typeof c.heading === 'string' && c.heading.length) ? c.heading : headingEl.textContent;
      headingEl.innerHTML = h
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/Vision/i, '<span class="mv-accent mv-accent--vision">$&</span>')
        .replace(/Mission/i, '<span class="mv-accent mv-accent--mission">$&</span>');
    }

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

    /* swap the Vision / Mission figure images if the CMS provides them.
       Order matches the markup: figure[0] = Vision, figure[1] = Mission. */
    var figs = $all('.mv-figure img', s);
    if (figs[0] && typeof c.vision_image === 'string' && c.vision_image) {
      figs[0].src = resolveAsset(c.vision_image);
    }
    if (figs[1] && typeof c.mission_image === 'string' && c.mission_image) {
      figs[1].src = resolveAsset(c.mission_image);
    }

    /* history title is intentionally hardcoded in HTML — not overridden from DB */
  }

  /* NOTE: the "Why Choose Us" (about) section was removed — the `about`
     section key now only positions/shows the hardcoded "Our Facilities"
     carousel via applyOrderAndVisibility(), so there is no content hydrator. */

  function hydratePartnerSchools(partners) {
    if (!Array.isArray(partners) || !partners.length) return;
    if (window.BPSPartnerCarousel && typeof window.BPSPartnerCarousel.build === 'function') {
      window.BPSPartnerCarousel.build(partners.map(function (p) {
        return {
          school_name: p.school_name,
          logo_path: resolveAsset(p.logo_path),
        };
      }));
    }
  }

  function hydrateCta(c) {
    var s = sectionEl('cta'); if (!s || !c) return;
    hydrateHeader(s, c);
    setText($('#cta-book', s), c.primary_label);
    setText($('#cta-contact', s), c.secondary_label);
  }

  /* Facilities section (lives in the "about" slot, data-ls="about").
     Managed via Website Management → "Our Facilities": an eyebrow / heading /
     subheading plus up to 5 landscape photo + caption pairs. The photos drive
     the landing-page carousel through window.renderFacilities(). */
  function hydrateFacilities(c) {
    var s = sectionEl('about'); if (!s || !c) return;
    setText($('.fac-eyebrow', s), c.label);
    setText($('.fac-heading', s), c.heading);
    setText($('.fac-sub', s), c.subheading);

    var list = [];
    // Preferred: a dynamic `facilities` array of { image, caption }.
    if (Array.isArray(c.facilities)) {
      c.facilities.forEach(function (f) {
        var src = f && f.image;
        if (src && typeof src === 'string' && src.trim()) {
          list.push({ src: resolveAsset(src.trim()), caption: (f.caption || '') });
        }
      });
    } else {
      // Legacy fallback: flat fac1_image / fac1_caption … keys.
      for (var i = 1; i <= 30; i++) {
        var legacySrc = c['fac' + i + '_image'];
        if (legacySrc && typeof legacySrc === 'string' && legacySrc.trim()) {
          list.push({ src: resolveAsset(legacySrc.trim()), caption: c['fac' + i + '_caption'] || '' });
        }
      }
    }
    if (list.length && typeof window.renderFacilities === 'function') {
      window.renderFacilities(list);
    }
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
    try { hydrateFacilities(content.about); } catch (e) {}
    try { hydrateCta(content.cta); } catch (e) {}
    try { applyOrderAndVisibility(data && data.sections); } catch (e) {}
    try { hydratePartnerSchools(data && data.partners); } catch (e) {}

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
