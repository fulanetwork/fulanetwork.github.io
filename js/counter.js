/* Animated number counters using Intersection Observer */
(function () {
  var counters = document.querySelectorAll('[data-counter]');
  if (!counters.length) return;

  // Try to load live node count before animating
  var nodesEl = document.querySelector('[data-stat="nodes"]');
  if (nodesEl) {
    fetch('/assets/data/network.json')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.total_nodes) {
          nodesEl.setAttribute('data-counter', String(data.total_nodes));
        }
      })
      .catch(function () { /* fallback to hardcoded value */ })
      .then(function () { initCounters(); });
  } else {
    initCounters();
  }

  function initCounters() {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          animateCounter(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.3 });

    counters.forEach(function (counter) {
      observer.observe(counter);
    });
  }

  function animateCounter(el) {
    var target = parseInt(el.getAttribute('data-counter'), 10);
    var suffix = el.getAttribute('data-suffix') || '';
    var prefix = el.getAttribute('data-prefix') || '';
    var duration = 2000;
    var startTime = null;

    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      var current = Math.floor(eased * target);
      el.textContent = prefix + current.toLocaleString('en-US') + suffix;
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = prefix + target.toLocaleString('en-US') + suffix;
      }
    }

    requestAnimationFrame(step);
  }
})();
