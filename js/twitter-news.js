(function () {
  var section = document.querySelector('.news');
  if (!section) return;

  var track = document.getElementById('twitter-news');
  var prevBtn = section.querySelector('.news__prev');
  var nextBtn = section.querySelector('.news__next');
  if (!track) return;

  fetch('/assets/data/instagram.json')
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data.posts || !data.posts.length) return;

      var posts = data.posts.map(function (p) {
        return {
          title: p.caption || '',
          link: p.permalink || '',
          date: p.timestamp || '',
          image: p.image ? '/' + p.image : ''
        };
      });

      var html = '';
      posts.forEach(function (post) {
        var title = post.title || '';
        var shortTitle = title.length > 120 ? title.substring(0, 120) + '...' : title;
        var date = formatRelativeDate(post.date);
        var imgHtml = post.image
          ? '<img src="' + escapeAttr(post.image) + '" alt="" class="news__card-img" loading="lazy">'
          : '<div class="news__card-img news__card-img--placeholder"></div>';

        html += '<a href="' + escapeAttr(post.link) + '" target="_blank" rel="noopener" class="news__card">'
          + imgHtml
          + '<div class="news__card-body">'
          + '<p class="news__card-title">' + escapeHtml(shortTitle) + '</p>'
          + '<span class="news__card-date">' + escapeHtml(date) + '</span>'
          + '</div>'
          + '</a>';
      });
      track.innerHTML = html;
      section.classList.add('news--loaded');

      // Arrow navigation
      if (prevBtn && nextBtn) {
        var scrollAmount = function () {
          var card = track.querySelector('.news__card');
          return card ? card.offsetWidth + 16 : 300;
        };
        prevBtn.addEventListener('click', function () {
          track.scrollBy({ left: -scrollAmount(), behavior: 'smooth' });
        });
        nextBtn.addEventListener('click', function () {
          track.scrollBy({ left: scrollAmount(), behavior: 'smooth' });
        });
      }
    })
    .catch(function (err) {
      console.warn('Latest News: failed to load feed', err);
    });

  function formatRelativeDate(dateStr) {
    if (!dateStr) return '';
    try {
      var d = new Date(dateStr);
      var now = new Date();
      var diff = Math.floor((now - d) / 1000);
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (e) {
      return '';
    }
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
