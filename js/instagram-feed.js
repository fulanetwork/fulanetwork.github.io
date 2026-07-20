(function () {
  var section = document.querySelector('.ig-feed');
  if (!section) return;

  var track = section.querySelector('.ig-feed__track');
  var prevBtn = section.querySelector('.ig-feed__prev');
  var nextBtn = section.querySelector('.ig-feed__next');
  if (!track) return;

  fetch('/assets/data/instagram.json')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data.posts || !data.posts.length) {
        return;
      }

      var html = '';
      data.posts.forEach(function (post) {
        var caption = post.caption || '';
        var shortCaption = caption.length > 80 ? caption.substring(0, 80) + '...' : caption;
        html += '<a href="' + post.permalink + '" target="_blank" rel="noopener" class="ig-feed__card">'
          + '<div class="ig-feed__img-wrap">'
          + '<img src="/' + post.image + '" alt="' + shortCaption.replace(/"/g, '&quot;') + '" class="ig-feed__img" loading="lazy">'
          + '<div class="ig-feed__caption">'
          + '<p class="ig-feed__caption-short">' + escapeHtml(shortCaption) + '</p>'
          + '<p class="ig-feed__caption-full">' + escapeHtml(caption) + '</p>'
          + '</div>'
          + '</div>'
          + '</a>';
      });
      track.innerHTML = html;
      section.classList.add('ig-feed--loaded');

      // Arrow navigation
      if (prevBtn && nextBtn) {
        var scrollAmount = function () {
          var card = track.querySelector('.ig-feed__card');
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
    .catch(function () {
      track.innerHTML = '<p style="text-align:center;color:var(--color-text-muted);padding:2rem;width:100%;">Could not load updates. Please try again later.</p>';
      section.classList.add('ig-feed--loaded');
    });

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }
})();
