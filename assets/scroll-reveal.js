/**
 * Premium Scroll-Reveal Controller
 * Lightweight, zero-dependency, IntersectionObserver-powered animation manager
 * Handles initial page load, scrolling reveals, staggered card grids,
 * dynamic client-side route re-renders, and accessibility.
 */
(function () {
  'use strict';

  // 1. Accessibility & Support Check
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced || !('IntersectionObserver' in window)) {
    // Graceful fallback: Do not activate hidden initial states; content remains normally visible
    return;
  }

  // 2. Enable animation styles on document element
  document.documentElement.classList.add('scroll-reveal-ready');

  // Track elements that have already been revealed
  const revealedElements = new WeakSet();

  // 3. Configure Intersection Observer
  // RootMargin of -25px triggers reveals just as the element enters the visible window
  const observerOptions = {
    root: null,
    rootMargin: '0px 0px -25px 0px',
    threshold: 0.05
  };

  function revealTarget(el) {
    if (!el || revealedElements.has(el)) return;
    revealedElements.add(el);
    el.classList.add('is-revealed');

    // If container has stagger, ensure all children are marked
    if (el.classList.contains('reveal-stagger')) {
      const children = el.children;
      for (let i = 0; i < children.length; i++) {
        children[i].classList.add('is-revealed');
      }
    }
  }

  const observer = new IntersectionObserver(function (entries, obs) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        revealTarget(entry.target);
        obs.unobserve(entry.target);
      }
    });
  }, observerOptions);

  // Elements that are already on screen when they are registered get their entrance right away (after a short beat); the rest wait for the
  // scroll observer above. The first look uses an IntersectionObserver too (same 95%-of-the-viewport rule as before) instead of reading
  // getBoundingClientRect() for every element, because those reads forced a full synchronous layout of the page while it was still loading.
  const initialObserver = new IntersectionObserver(function (entries, obs) {
    entries.forEach(function (entry) {
      const el = entry.target;
      obs.unobserve(el);
      if (revealedElements.has(el)) return;
      if (entry.isIntersecting) {
        // Subtle staggered entrance for elements already in viewport upon initial load
        setTimeout(function () {
          revealTarget(el);
        }, 40);
      } else {
        observer.observe(el);
      }
    });
  }, { root: null, rootMargin: '0px 0px -5% 0px', threshold: 0 });

  /**
   * Scan and register elements for scroll reveal
   * @param {HTMLElement|Document} root Context to search for reveal targets
   */
  function observeElements(root) {
    const context = root || document;
    const elements = context.querySelectorAll('.reveal-on-scroll, .reveal-stagger');

    elements.forEach(function (el) {
      if (revealedElements.has(el) || el.classList.contains('is-revealed')) {
        return;
      }
      initialObserver.observe(el);
    });
  }

  // 4. Initial trigger on DOM readiness
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      observeElements();
    });
  } else {
    observeElements();
  }

  // 5. Expose public API for re-rendered or dynamically injected content
  window.refreshScrollReveal = function (container) {
    if (prefersReduced) return;
    requestAnimationFrame(function () {
      observeElements(container || document);
    });
  };

  // 6. Safety Net: Ensure all elements become visible even if browser viewport heuristics fail
  setTimeout(function () {
    const hidden = document.querySelectorAll('.reveal-on-scroll:not(.is-revealed), .reveal-stagger:not(.is-revealed)');
    hidden.forEach(function (el) {
      revealTarget(el);
    });
  }, 3500);

})();
