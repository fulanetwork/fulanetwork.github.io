(function () {
  var section = document.querySelector('.pulse');
  if (!section) return;

  var container = document.getElementById('project-pulse');
  if (!container) return;

  var cache = {};
  var history = [];
  var currentIndex = 0;

  var chevronLeft = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';
  var chevronRight = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>';

  fetch('/assets/data/pulse.json')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data.briefing) return;

      cache[data.week_of] = data;
      history.push(data.week_of);
      currentIndex = 0;

      renderPulse(data);
      section.classList.add('pulse--loaded');

      checkPrev(data.week_of);
    })
    .catch(function () {
      // Silently fail — section stays hidden
    });

  function renderPulse(data) {
    var briefing = stripTags(data.briefing);

    var weekLabel = '';
    if (data.week_of) {
      try {
        var d = new Date(data.week_of + 'T00:00:00Z');
        weekLabel = 'Week of ' + d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      } catch (e) {
        weekLabel = '';
      }
    }

    var sourcesHtml = '';
    if (data.sources && data.sources.length) {
      sourcesHtml = '<div class="pulse__sources">';
      data.sources.forEach(function (url) {
        var domain = '';
        try { domain = new URL(url).hostname.replace('www.', ''); } catch (e) { domain = url; }
        sourcesHtml += '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener" class="pulse__source-link">' + escapeHtml(domain) + '</a>';
      });
      sourcesHtml += '</div>';
    }

    container.innerHTML =
      '<div class="pulse__meta">'
        + '<button class="pulse__nav pulse__nav--prev" style="display:none" aria-label="Previous pulse">' + chevronLeft + '</button>'
        + '<span class="pulse__week">' + escapeHtml(weekLabel) + '</span>'
        + '<button class="pulse__nav pulse__nav--next" style="display:none" aria-label="Next pulse">' + chevronRight + '</button>'
      + '</div>'
      + '<h2 class="pulse__headline">' + escapeHtml(stripTags(data.headline)) + '</h2>'
      + '<p class="pulse__subtitle">' + escapeHtml(stripTags(data.subtitle)) + '</p>'
      + '<p class="pulse__briefing">' + escapeHtml(briefing) + '</p>'
      + sourcesHtml;

    showNav();
  }

  function checkPrev(weekOf) {
    var path = '/assets/data/history/pulse-before-' + weekOf + '.json';
    fetch(path)
      .then(function (res) {
        if (!res.ok) throw new Error('not found');
        return res.json();
      })
      .then(function (data) {
        if (!data.briefing || !data.week_of) return;
        cache[data.week_of] = data;
        if (history.indexOf(data.week_of) === -1) {
          history.push(data.week_of);
        }
        showNav();
      })
      .catch(function () {
        showNav();
      });
  }

  function navigate(direction) {
    var newIndex = currentIndex + direction;
    if (newIndex < 0 || newIndex >= history.length) return;

    currentIndex = newIndex;
    var weekOf = history[currentIndex];
    var data = cache[weekOf];
    if (!data) return;

    renderPulse(data);

    if (direction > 0 && currentIndex === history.length - 1) {
      checkPrev(weekOf);
    }
  }

  function showNav() {
    var prevBtn = container.querySelector('.pulse__nav--prev');
    var nextBtn = container.querySelector('.pulse__nav--next');
    if (!prevBtn || !nextBtn) return;

    prevBtn.style.display = currentIndex < history.length - 1 ? '' : 'none';
    nextBtn.style.display = currentIndex > 0 ? '' : 'none';

    prevBtn.onclick = function () { navigate(1); };
    nextBtn.onclick = function () { navigate(-1); };
  }

  function stripTags(str) {
    return str.replace(/<cite[^>]*>/gi, '').replace(/<\/cite>/gi, '').replace(/<[^>]+>/g, '');
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
})();
