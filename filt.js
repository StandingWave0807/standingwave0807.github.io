(function () {
var SITE = window.SITE, reduce = SITE.reduce, spring = SITE.spring, readPx = SITE.readPx;
/* ================= filter list ================= */
  var filters = document.getElementById("filters");
  var cpill = document.getElementById("chip-thumb");
  var chips = [].slice.call(filters.querySelectorAll(".chip"));
  function placeChipPill(el, animate) {
    var g = filters.getBoundingClientRect(), r = el.getBoundingClientRect();
    var x = r.left - g.left, y = r.top - g.top, w = r.width, h = r.height;
    cpill.style.top = y + "px"; cpill.style.height = h + "px"; cpill.style.opacity = 1;
    if (!animate) { cpill.style.transform = "translateX(" + x + "px)"; cpill.style.width = w + "px"; return; }
    var m = /translateX\((-?[\d.]+)px\)/.exec(cpill.style.transform);
    spring("cpx", x, function (v) { cpill.style.transform = "translateX(" + v + "px)"; },
           { from: m ? parseFloat(m[1]) : x, response: 0.32, damping: 1 });
    spring("cpw", w, function (v) { cpill.style.width = v + "px"; },
           { from: readPx(cpill, "width") || w, response: 0.32, damping: 1 });
  }
  var items = [].slice.call(document.querySelectorAll("#items .item"));
  var count = document.getElementById("note-count");
  var status = document.getElementById("note-status");
  function apply(cat, animate) {
    var wasTop = new Map(), wasShown = new Map();
    items.forEach(function (el) { wasShown.set(el, !el.hidden); wasTop.set(el, el.getBoundingClientRect().top); });
    var shown = 0;
    items.forEach(function (el) {
      var on = cat === "all" || el.dataset.cat === cat;
      el.hidden = !on;
      if (on) shown++;
    });
    count.textContent = shown + " / " + items.length;
    status.textContent = "显示 " + shown + " 条";
    if (!animate || reduce) return;
    items.forEach(function (el) {
      if (el.hidden) return;
      var dy = wasTop.get(el) - el.getBoundingClientRect().top;
      if (wasShown.get(el)) {
        if (Math.abs(dy) > 0.5) {
          spring(null, 0, function (v) { el.style.transform = "translate3d(0," + v + "px,0)"; },
                 { from: dy, response: 0.34, damping: 1, done: function () { el.style.transform = ""; } });
        }
      } else {
        spring(null, 1, function (v) {
          el.style.opacity = v;
          el.style.transform = "translate3d(0," + ((1 - v) * 6) + "px,0)";
        }, { from: 0, response: 0.3, damping: 1, done: function () { el.style.opacity = ""; el.style.transform = ""; } });
      }
    });
  }
  chips.forEach(function (c) {
    c.addEventListener("click", function () {
      chips.forEach(function (o) { o.setAttribute("aria-pressed", o === c ? "true" : "false"); });
      placeChipPill(c, true);
      apply(c.dataset.cat, true);
    });
  });
  placeChipPill(chips[0], false);
  apply("all", false);
})();
