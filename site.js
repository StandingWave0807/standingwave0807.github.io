(function () {
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var live = {}, queue = [], raf = 0, last = 0;

  function frame(now) {
    var dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
    last = now;
    for (var i = queue.length - 1; i >= 0; i--) {
      var s = queue[i], steps = Math.max(1, Math.round(dt / 0.004)), h = dt / steps;
      var w0 = (2 * Math.PI) / s.response;
      for (var k = 0; k < steps; k++) {
        s.v += (-w0 * w0 * (s.x - s.target) - 2 * s.damping * w0 * s.v) * h;
        s.x += s.v * h;
      }
      s.render(s.x);
      if (Math.abs(s.x - s.target) < 0.05 && Math.abs(s.v) < 0.5) {
        s.x = s.target; s.v = 0; s.render(s.x);
        if (s.done) s.done();
        queue.splice(i, 1);
        if (s.key) delete live[s.key];
      }
    }
    raf = queue.length ? requestAnimationFrame(frame) : 0;
    if (!queue.length) last = 0;
  }
  function spring(key, target, render, o) {
    o = o || {};
    if (reduce && !o.keep) { render(target); if (o.done) o.done(); return; }
    var s = key && live[key];
    if (s) { s.target = target; if (o.velocity) s.v = o.velocity; s.done = o.done; return; }
    s = { key: key, x: o.from !== undefined ? o.from : target, v: o.velocity || 0,
          target: target, damping: o.damping || 1, response: o.response || 0.35,
          render: render, done: o.done };
    if (key) live[key] = s;
    queue.push(s);
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function readPx(el, prop) { var v = parseFloat(el.style[prop]); return isNaN(v) ? 0 : v; }
  window.SITE = { reduce: reduce, spring: spring, readPx: readPx };
})();
