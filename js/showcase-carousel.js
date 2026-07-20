(function () {
  var carousel = document.querySelector('.showcase-carousel');
  if (!carousel) return;

  var track = carousel.querySelector('.showcase-carousel__track');
  var slides = carousel.querySelectorAll('.showcase-slide');
  var dots = carousel.querySelectorAll('.showcase-carousel__dot');
  var prevBtn = carousel.querySelector('.showcase-carousel__arrow--prev');
  var nextBtn = carousel.querySelector('.showcase-carousel__arrow--next');
  var current = 0;
  var count = slides.length;
  var interval = null;
  var DELAY = 7000;
  var paused = false;

  // Aria-live region for screen reader announcements
  var liveRegion = document.createElement('div');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  liveRegion.className = 'sr-only';
  carousel.appendChild(liveRegion);

  function goTo(index) {
    if (index < 0) index = count - 1;
    if (index >= count) index = 0;
    current = index;
    track.style.transform = 'translateX(-' + (current * 100) + '%)';
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('showcase-carousel__dot--active', i === current);
    }
    liveRegion.textContent = 'Slide ' + (current + 1) + ' of ' + count;
  }

  function next() { goTo(current + 1); }
  function prev() { goTo(current - 1); }

  function resetTimer() {
    clearInterval(interval);
    if (!paused) {
      interval = setInterval(next, DELAY);
    }
  }

  prevBtn.addEventListener('click', function () { prev(); resetTimer(); });
  nextBtn.addEventListener('click', function () { next(); resetTimer(); });

  for (var i = 0; i < dots.length; i++) {
    dots[i].addEventListener('click', function () {
      goTo(parseInt(this.dataset.slide, 10));
      resetTimer();
    });
  }

  carousel.addEventListener('mouseenter', function () { clearInterval(interval); });
  carousel.addEventListener('mouseleave', function () { resetTimer(); });

  // Keyboard navigation
  carousel.setAttribute('tabindex', '0');
  carousel.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
      resetTimer();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
      resetTimer();
    }
  });

  // Touch swipe
  var startX = 0;
  carousel.addEventListener('touchstart', function (e) {
    startX = e.changedTouches[0].clientX;
  }, { passive: true });
  carousel.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 50) {
      dx > 0 ? prev() : next();
      resetTimer();
    }
  }, { passive: true });

  // Pause when tab is hidden
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      paused = true;
      clearInterval(interval);
    } else {
      paused = false;
      resetTimer();
    }
  });

  resetTimer();
})();
