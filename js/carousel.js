/* Partner logo carousel - CSS-based infinite scroll */
(function () {
  var tracks = document.querySelectorAll('.carousel__track');
  if (!tracks.length) return;

  tracks.forEach(function (track) {
    // Duplicate content for seamless loop
    var content = track.innerHTML;
    track.innerHTML = content + content;
  });
})();
