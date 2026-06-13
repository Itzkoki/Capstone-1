/* ============================================================
   auth-carousel.js — shared image slideshow for login + register
   ------------------------------------------------------------
   • Auto-rotates the brand image panel without a page refresh.
   • Smooth cross-fade (driven by the .is-active class in CSS).
   • Clickable indicator dots + pause-on-hover/focus.
   • Preloads images so transitions never cause a layout shift.
   • Honours prefers-reduced-motion (no Ken-Burns zoom, instant-ish fade).
   • Pauses while the browser tab is hidden to save work.

   Markup contract (built by initAuthCarousel):
     <div class="auth-split__media"> … injected slides + dots … </div>
   ============================================================ */
(function (global) {
  'use strict';

  function initAuthCarousel(opts) {
    var mediaEl = opts.mediaEl;
    var images = opts.images || [];
    var captions = opts.captions || [];
    var interval = opts.interval || 5000;
    if (!mediaEl || images.length === 0) return;

    var reduceMotion = global.matchMedia &&
      global.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---- build slide layers --------------------------------------
    var slides = images.map(function (src, i) {
      var slide = document.createElement('div');
      slide.className = 'auth-slide' + (i === 0 ? ' is-active' : '');
      slide.setAttribute('role', 'img');
      slide.setAttribute('aria-hidden', i === 0 ? 'false' : 'true');
      if (captions[i] && captions[i].headline) {
        slide.setAttribute('aria-label', captions[i].headline);
      }
      // first image inline so it paints immediately; rest after preload
      if (i === 0) slide.style.backgroundImage = 'url("' + src + '")';
      mediaEl.appendChild(slide);
      return slide;
    });

    // ---- preload remaining images, then attach as backgrounds ----
    images.forEach(function (src, i) {
      if (i === 0) return;
      var img = new Image();
      img.onload = function () {
        slides[i].style.backgroundImage = 'url("' + src + '")';
      };
      img.src = src;
    });

    // ---- optional live caption (headline + sub) ------------------
    var headlineEl = opts.headlineEl || null;
    var subEl = opts.subEl || null;
    function paintCaption(i) {
      if (!captions[i]) return;
      if (headlineEl && captions[i].headline != null) {
        headlineEl.textContent = captions[i].headline;
      }
      if (subEl && captions[i].sub != null) {
        subEl.textContent = captions[i].sub;
      }
    }
    paintCaption(0);

    // ---- indicator dots ------------------------------------------
    var dotsWrap = opts.dotsEl || null;
    var dots = [];
    if (dotsWrap) {
      images.forEach(function (_, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'auth-dot' + (i === 0 ? ' is-active' : '');
        b.setAttribute('aria-label', 'Show slide ' + (i + 1) + ' of ' + images.length);
        b.addEventListener('click', function () { goTo(i, true); });
        dotsWrap.appendChild(b);
        dots.push(b);
      });
    }

    // ---- transition core -----------------------------------------
    var current = 0;
    var timer = null;

    function goTo(next, fromUser) {
      if (next === current) return;
      slides[current].classList.remove('is-active');
      slides[current].setAttribute('aria-hidden', 'true');
      slides[next].classList.add('is-active');
      slides[next].setAttribute('aria-hidden', 'false');
      if (dots.length) {
        dots[current].classList.remove('is-active');
        dots[next].classList.add('is-active');
      }
      paintCaption(next);
      current = next;
      if (fromUser) restart();        // reset cadence after manual nav
    }

    function advance() {
      goTo((current + 1) % slides.length, false);
    }

    // ---- timing + pause logic ------------------------------------
    function start() {
      if (slides.length < 2 || timer) return;
      timer = global.setInterval(advance, interval);
    }
    function stop() {
      if (timer) { global.clearInterval(timer); timer = null; }
    }
    function restart() { stop(); start(); }

    // pause on hover / focus within the media panel
    mediaEl.addEventListener('mouseenter', stop);
    mediaEl.addEventListener('mouseleave', start);
    mediaEl.addEventListener('focusin', stop);
    mediaEl.addEventListener('focusout', start);

    // pause when tab is backgrounded
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });

    start();

    // expose a tiny handle (not required, but handy)
    return { goTo: goTo, start: start, stop: stop };
  }

  global.initAuthCarousel = initAuthCarousel;
})(window);
