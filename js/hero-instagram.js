(function () {
  var wrap = document.querySelector('.network-window__image-wrap');
  if (!wrap) return;

  var frame = document.getElementById('hero-instagram');
  var skeleton = wrap.querySelector('.network-window__skeleton');

  fetch('/assets/data/instagram.json?v=' + Date.now())
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var posts = data.posts && data.posts.slice(0, 5);
      if (!posts || !posts.length) throw new Error('No posts');
      var post = posts[Math.floor(Math.random() * posts.length)];
      if (!post.image) throw new Error('No image');

      var a = document.createElement('a');
      a.href = post.permalink;
      a.target = '_blank';
      a.rel = 'noopener';

      var img = document.createElement('img');
      img.src = '/' + post.image;
      img.alt = post.caption ? post.caption.slice(0, 80) : 'Functionland on Instagram';
      img.className = 'network-window__img';
      img.loading = 'eager';
      img.style.opacity = '0';
      img.style.transition = 'opacity 0.4s ease';

      img.onload = function () {
        if (skeleton) skeleton.style.display = 'none';
        a.appendChild(img);
        wrap.appendChild(a);
        // Force reflow then fade in
        img.offsetHeight;
        img.style.opacity = '1';
      };

      img.onerror = function () {
        if (frame) frame.style.display = 'none';
      };
    })
    .catch(function () {
      if (frame) frame.style.display = 'none';
    });
})();
