/* Navigation: hamburger toggle, dropdown behavior */
(function () {
  const hamburger = document.querySelector('.hamburger');
  const nav = document.querySelector('.nav');
  const dropdownToggles = document.querySelectorAll('.nav__item--has-dropdown > .nav__link');

  if (!hamburger || !nav) return;

  // Hamburger toggle
  hamburger.addEventListener('click', function () {
    hamburger.classList.toggle('active');
    nav.classList.toggle('active');
    var isOpen = nav.classList.contains('active');
    document.body.style.overflow = isOpen ? 'hidden' : '';
    hamburger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });

  // Mobile dropdown toggle (click)
  dropdownToggles.forEach(function (toggle) {
    toggle.addEventListener('click', function (e) {
      if (window.innerWidth > 768) return;
      e.preventDefault();
      const dropdown = this.nextElementSibling;
      if (!dropdown) return;

      // Close other dropdowns
      document.querySelectorAll('.nav__dropdown.active').forEach(function (d) {
        if (d !== dropdown) d.classList.remove('active');
      });

      dropdown.classList.toggle('active');
    });
  });

  function closeMenu() {
    hamburger.classList.remove('active');
    nav.classList.remove('active');
    document.body.style.overflow = '';
    hamburger.setAttribute('aria-expanded', 'false');
  }

  // Close menu on outside click
  document.addEventListener('click', function (e) {
    if (!nav.contains(e.target) && !hamburger.contains(e.target)) {
      closeMenu();
    }
  });

  // Close on escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeMenu();
    }
  });

  // Header scroll shadow
  var header = document.querySelector('.site-header');
  var scrolled = false;
  window.addEventListener('scroll', function () {
    var shouldAdd = window.scrollY > 10;
    if (shouldAdd !== scrolled) {
      scrolled = shouldAdd;
      header.classList.toggle('site-header--scrolled', scrolled);
    }
  }, { passive: true });

  // Reset on resize
  window.addEventListener('resize', function () {
    if (window.innerWidth > 768) {
      closeMenu();
      document.querySelectorAll('.nav__dropdown.active').forEach(function (d) {
        d.classList.remove('active');
      });
    }
  });

  // Platform-aware header CTA
  var navCta = document.getElementById('nav-cta');
  if (navCta) {
    var ua = navigator.userAgent || '';
    if (/android/i.test(ua)) {
      navCta.href = 'https://play.google.com/store/apps/details?id=land.fx.files';
      navCta.target = '_blank';
      navCta.rel = 'noopener';
      navCta.textContent = 'Get FxFiles';
    } else if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      navCta.href = 'https://apps.apple.com/ca/app/fxfiles/id1658500313';
      navCta.target = '_blank';
      navCta.rel = 'noopener';
      navCta.textContent = 'Get FxFiles';
    }
  }
})();
