import createGlobe from 'https://esm.sh/cobe';

(function () {
  var canvas = document.getElementById('cobe-globe');
  if (!canvas) return;

  var section = canvas.closest('.node-network');
  var container = canvas.parentElement;
  var globe = null;
  var phi = 0;
  var pointerDown = false;
  var pointerX = 0;
  var dragDelta = 0;
  var isVisible = false;
  var resizeTimer = null;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 24 Fula node locations [lat, lng] from live-map data
  var markers = [
    { location: [40.4173, -82.9071], size: 0.06 },
    { location: [38.8375, -120.8958], size: 0.06 },
    { location: [40.4637, -3.7492], size: 0.06 },
    { location: [59.3293, 18.0686], size: 0.06 },
    { location: [35.6762, 139.6503], size: 0.06 },
    { location: [-33.8688, 151.2093], size: 0.06 },
    { location: [51.5074, -0.1278], size: 0.06 },
    { location: [52.52, 13.405], size: 0.06 },
    { location: [1.3521, 103.8198], size: 0.06 },
    { location: [19.076, 72.8777], size: 0.06 },
    { location: [-23.5505, -46.6333], size: 0.06 },
    { location: [43.6532, -79.3832], size: 0.06 },
    { location: [25.2048, 55.2708], size: 0.06 },
    { location: [55.7558, 37.6176], size: 0.06 },
    { location: [37.5665, 126.978], size: 0.06 },
    { location: [-33.9249, 18.4241], size: 0.06 },
    { location: [19.4326, -99.1332], size: 0.06 },
    { location: [-34.6037, -58.3816], size: 0.06 },
    { location: [59.9139, 10.7522], size: 0.06 },
    { location: [13.7563, 100.5018], size: 0.06 },
    { location: [41.0082, 28.9784], size: 0.06 },
    { location: [6.5244, 3.3792], size: 0.06 },
    { location: [30.0444, 31.2357], size: 0.06 },
    { location: [32.0853, 34.7818], size: 0.06 }
  ];

  function sizeCanvas() {
    var rect = container.getBoundingClientRect();
    var size = Math.min(rect.width, rect.height) || 400;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    return { size: size, dpr: dpr };
  }

  function initGlobe() {
    try {
    var dims = sizeCanvas();
    globe = createGlobe(canvas, {
      devicePixelRatio: dims.dpr,
      width: dims.size * dims.dpr,
      height: dims.size * dims.dpr,
      phi: 0,
      theta: 0.25,
      dark: 1,
      diffuse: 1.2,
      mapSamples: 16000,
      mapBrightness: 6,
      baseColor: [0.15, 0.15, 0.2],
      markerColor: [0.114, 0.725, 0.329],
      glowColor: [0.114, 0.725, 0.329],
      markers: markers,
      onRender: function (state) {
        if (!isVisible) return;
        if (!pointerDown && !reducedMotion) {
          phi += 0.003;
        }
        phi += dragDelta;
        dragDelta *= 0.95;
        state.phi = phi;
      }
    });
    } catch (err) {
      console.warn('Globe initialization failed:', err);
      var globeSection = canvas.closest('.node-network__globe');
      if (globeSection) globeSection.style.display = 'none';
    }
  }

  // Pointer events for drag-to-rotate
  canvas.addEventListener('pointerdown', function (e) {
    pointerDown = true;
    pointerX = e.clientX;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('pointerup', function () {
    pointerDown = false;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('pointerout', function () {
    pointerDown = false;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('pointermove', function (e) {
    if (pointerDown) {
      dragDelta = (e.clientX - pointerX) / 200;
      pointerX = e.clientX;
    }
  });

  // Prevent scroll while dragging on touch
  canvas.addEventListener('touchmove', function (e) {
    if (pointerDown) e.preventDefault();
  }, { passive: false });

  // IntersectionObserver — only render when visible
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      isVisible = entry.isIntersecting;
      if (isVisible && !globe) {
        initGlobe();
      }
    });
  }, { threshold: 0.1 });

  observer.observe(section);

  // Debounced resize
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (globe) {
        globe.destroy();
        globe = null;
        if (isVisible) initGlobe();
      }
    }, 300);
  });
})();
