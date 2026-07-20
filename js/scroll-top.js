/* Scroll-to-top floating button */
(function () {
  var btn = document.getElementById('scroll-top');
  if (!btn) return;

  var visible = false;
  var ticking = false;

  function onScroll() {
    if (!ticking) {
      requestAnimationFrame(function () {
        var show = window.scrollY > 500;
        if (show !== visible) {
          visible = show;
          btn.classList.toggle('scroll-top--visible', visible);
        }
        ticking = false;
      });
      ticking = true;
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  btn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
