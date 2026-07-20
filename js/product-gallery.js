/* Product image gallery - thumbnail click swaps main image */
(function () {
  var mainImg = document.querySelector('.pdp-gallery__main-img');
  var thumbs = document.querySelectorAll('.pdp-gallery__thumb');
  if (!mainImg || !thumbs.length) return;

  thumbs.forEach(function (thumb) {
    thumb.addEventListener('click', function () {
      mainImg.src = this.dataset.full;
      mainImg.alt = this.alt;
      thumbs.forEach(function (t) { t.classList.remove('pdp-gallery__thumb--active'); });
      this.classList.add('pdp-gallery__thumb--active');
    });
  });
})();

/* Slideshow - auto-rotate every 5s, pause on hover or manual switch */
(function () {
  var slides = document.querySelectorAll('.pdp-slideshow__slide');
  var dots = document.querySelectorAll('.pdp-slideshow__dot');
  if (slides.length < 2) return;

  var current = 0;
  var timer = null;
  var INTERVAL = 5000;

  function goTo(index) {
    slides[current].classList.remove('pdp-slideshow__slide--active');
    dots[current].classList.remove('pdp-slideshow__dot--active');
    current = index % slides.length;
    slides[current].classList.add('pdp-slideshow__slide--active');
    dots[current].classList.add('pdp-slideshow__dot--active');
  }

  function startAuto() {
    stopAuto();
    timer = setInterval(function () { goTo(current + 1); }, INTERVAL);
  }

  function stopAuto() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  dots.forEach(function (dot, i) {
    dot.addEventListener('click', function () {
      goTo(i);
      startAuto(); // restart timer after manual switch
    });
  });

  var slideshow = document.querySelector('.pdp-slideshow');
  if (slideshow) {
    slideshow.addEventListener('mouseenter', stopAuto);
    slideshow.addEventListener('mouseleave', startAuto);
  }

  startAuto();
})();
