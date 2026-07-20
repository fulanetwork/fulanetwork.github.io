/* Generic tablist switching — syncs all tablists by matching tab label */
(function () {
  var tablists = document.querySelectorAll('[role="tablist"]');
  if (!tablists.length) return;

  function activateTab(tablist, tab) {
    var container = tablist.parentElement;
    var tabs = tablist.querySelectorAll('[role="tab"]');
    var panels = container.querySelectorAll('[role="tabpanel"]');

    tabs.forEach(function (t) {
      t.classList.remove('how-it-works__tab--active');
      t.setAttribute('aria-selected', 'false');
    });
    panels.forEach(function (p) {
      p.classList.remove('how-it-works__panel--active');
      p.hidden = true;
    });
    tab.classList.add('how-it-works__tab--active');
    tab.setAttribute('aria-selected', 'true');
    var panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (panel) {
      panel.classList.add('how-it-works__panel--active');
      panel.hidden = false;
    }
  }

  function syncOtherTablists(sourceTablist, label) {
    tablists.forEach(function (tl) {
      if (tl === sourceTablist) return;
      var match = Array.prototype.find.call(
        tl.querySelectorAll('[role="tab"]'),
        function (t) { return t.textContent.trim() === label; }
      );
      if (match) activateTab(tl, match);
    });
  }

  tablists.forEach(function (tablist) {
    var tabs = tablist.querySelectorAll('[role="tab"]');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        activateTab(tablist, tab);
        syncOtherTablists(tablist, tab.textContent.trim());
      });
    });
  });
})();
