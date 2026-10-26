(function () {
var SITE = window.SITE, reduce = SITE.reduce, spring = SITE.spring, readPx = SITE.readPx;
/* ================= molecule drawing (schematic) ================= */
  var R = 30, BOND = 30;
  function v(cx, cy, i) { var a = (-90 + 60 * i) * Math.PI / 180; return [cx + R * Math.cos(a), cy + R * Math.sin(a)]; }
  function line(x1, y1, x2, y2, cls) {
    return '<line class="' + (cls || 'b') + '" x1="' + r2(x1) + '" y1="' + r2(y1) + '" x2="' + r2(x2) + '" y2="' + r2(y2) + '"/>';
  }
  function r2(n) { return Math.round(n * 10) / 10; }
  function hex(cx, cy) {
    var p = [];
    for (var i = 0; i < 6; i++) p.push(r2(v(cx, cy, i)[0]) + "," + r2(v(cx, cy, i)[1]));
    return '<polygon class="b" points="' + p.join(" ") + '"/>';
  }
  /* aromatic = inner circle; quinoid = two inner double bonds */
  function ring(cx, cy, kind) {
    var out = hex(cx, cy);
    if (kind === "quinoid") {
      out += line(cx - R * 0.55, cy - R * 0.45, cx + R * 0.55, cy - R * 0.45, "b2");
      out += line(cx - R * 0.55, cy + R * 0.45, cx + R * 0.55, cy + R * 0.45, "b2");
    } else {
      out += '<circle class="b2" cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + (R * 0.58) + '"/>';
    }
    return out;
  }
  function label(x, y, text, hi) {
    return '<text class="lab' + (hi ? ' hi' : '') + '" x="' + r2(x) + '" y="' + r2(y) + '" text-anchor="middle" dominant-baseline="middle">' + text + '</text>';
  }
  /* substituent: bond from vertex i outward + text */
  function sub(cx, cy, i, text, hi) {
    var p = v(cx, cy, i), a = (-90 + 60 * i) * Math.PI / 180;
    var q = [p[0] + BOND * Math.cos(a), p[1] + BOND * Math.sin(a)];
    return line(p[0], p[1], q[0], q[1]) + label(q[0] + 9 * Math.cos(a), q[1] + 9 * Math.sin(a), text, hi);
  }

  function phenolSVG() {
    return ring(320, 165, "aromatic") + sub(320, 165, 0, "OH", true);
  }
  function catecholSVG() {
    return ring(320, 165, "aromatic") + sub(320, 165, 0, "OH", true) + sub(320, 165, 1, "OH", true)
      + '<text class="lab" x="320" y="252" text-anchor="middle">1,2-位 · 邻位</text>';
  }
  /* phenolphthalein: central sp3 C carries two 4-hydroxyphenyl groups and one
     benzo ring; the ortho carboxyl closes the lactone. Geometry is derived from
     ring radius R and bond length BOND so the connectivity stays honest. */
  function ppSVG(base) {
    var C = [320, 178], d = R + BOND;
    var A = [C[0], C[1] - d];                                   // top: becomes quinoid in base
    var L = [C[0] - d * 0.866, C[1] + d * 0.5];                 // lower-left
    var Rt = [C[0] + d * 0.866, C[1] + d * 0.5];                // right: benzo of the phthalide
    var out = "";
    var aAttach = v(A[0], A[1], 3), lAttach = v(L[0], L[1], 1), rAttach = v(Rt[0], Rt[1], 5);
    var rOrtho = v(Rt[0], Rt[1], 0);
    var carb = [rOrtho[0], rOrtho[1] - BOND];                   // carboxyl / lactone carbonyl carbon
    var mx = (carb[0] + C[0]) / 2, my = (carb[1] + C[1]) / 2;
    var vx = carb[0] - C[0], vy = carb[1] - C[1], vn = Math.hypot(vx, vy);
    var rise = Math.sqrt(Math.max(1, BOND * BOND - (vn / 2) * (vn / 2)));
    var lactO = [mx - vy / vn * rise, my + vx / vn * rise];     // apex of the lactone pentagon

    out += line(C[0], C[1], aAttach[0], aAttach[1]);
    if (base) out += line(C[0] + 5, C[1], aAttach[0] + 5, aAttach[1], "b");
    out += line(C[0], C[1], lAttach[0], lAttach[1]);
    out += line(C[0], C[1], rAttach[0], rAttach[1]);

    out += ring(A[0], A[1], base ? "quinoid" : "aromatic");
    var aPara = v(A[0], A[1], 0);
    if (base) {
      out += line(aPara[0] - 4, aPara[1], aPara[0] - 4, aPara[1] - BOND);
      out += line(aPara[0] + 4, aPara[1], aPara[0] + 4, aPara[1] - BOND);
      out += label(aPara[0], aPara[1] - BOND - 9, "O", true);
    } else {
      out += line(aPara[0], aPara[1], aPara[0], aPara[1] - BOND);
      out += label(aPara[0], aPara[1] - BOND - 7, "OH", false);
    }

    out += ring(L[0], L[1], "aromatic");
    var lPara = v(L[0], L[1], 4);
    var ldir = [lPara[0] - L[0], lPara[1] - L[1]];
    var ln = Math.hypot(ldir[0], ldir[1]);
    out += line(lPara[0], lPara[1], lPara[0] + ldir[0] / ln * BOND, lPara[1] + ldir[1] / ln * BOND);
    out += label(lPara[0] + ldir[0] / ln * (BOND + 9), lPara[1] + ldir[1] / ln * (BOND + 9), base ? "O⁻" : "OH", base);

    out += ring(Rt[0], Rt[1], "aromatic");
    out += line(rOrtho[0], rOrtho[1], carb[0], carb[1]);
    if (base) {
      out += label(carb[0] + 4, carb[1] - 10, "COO⁻", true);
    } else {
      out += line(carb[0], carb[1], lactO[0], lactO[1]);
      out += line(lactO[0], lactO[1], C[0], C[1]);
      out += label(lactO[0] - 11, lactO[1] + 1, "O", false);
      out += line(carb[0] + 5, carb[1], carb[0] + 5, carb[1] - BOND + 4, "b");
      out += label(carb[0] + 5, carb[1] - BOND - 2, "O", false);
    }
    out += '<circle cx="' + C[0] + '" cy="' + C[1] + '" r="2.8" class="dot"/>';
    return out;
  }

  var MOL = {
    phenol: {
      formula: "C₆H₅OH", draw: phenolSVG, ph: false,
      note: "<b>苯酚</b>：一个羟基接在苯环上。共轭体系只有六个碳，吸收落在紫外区，所以溶液无色。pKa 约 10。"
    },
    catechol: {
      formula: "C₆H₄(OH)₂", draw: catecholSVG, ph: false,
      note: "<b>邻苯二酚</b>：两个羟基挪到相邻位置。仍然无色，但邻位二酚很容易被氧化成邻苯醌——颜色就是从这一步开始出现的。"
    },
    phenolphthalein: {
      formula: "C₂₀H₁₄O₄", draw: function (base) { return ppSVG(base); }, ph: true,
      note: "<b>酚酞</b>：两个<b>对位</b>羟基苯基连在同一个 sp³ 碳上，再加一个内酯环。它由苯酚与邻苯二甲酸酐缩合制得，和邻苯二酚是两条路。"
    }
  };

  var stage = document.getElementById("stage");
  var formulaEl = document.getElementById("formula");
  var noteEl = document.getElementById("mol-note");
  var phBox = document.getElementById("ph");
  var phRange = document.getElementById("ph-range");
  var phOut = document.getElementById("ph-out");
  var phSwatch = document.getElementById("ph-swatch");
  var current = "phenol";
  var BASE = false;

  function tint(frag, color) {
    frag.querySelectorAll(".b,.b2").forEach(function (n) { n.style.stroke = color; });
    frag.querySelectorAll(".dot").forEach(function (n) { n.style.fill = color; });
    frag.querySelectorAll(".lab:not(.hi)").forEach(function (n) { n.style.fill = "var(--muted)"; });
  }
  function fit(frag) {
    var svg = frag.ownerSVGElement;
    if (!svg) return;
    var b = frag.getBBox(), pad = 26;
    svg.setAttribute("viewBox", r2(b.x - pad) + " " + r2(b.y - pad) + " " +
                              r2(b.width + pad * 2) + " " + r2(b.height + pad * 2));
  }
  function paint() {
    var m = MOL[current];
    var color = m.ph && BASE ? "var(--fuchsia)" : "var(--ink-2)";
    stage.innerHTML =
      '<svg class="mol" viewBox="0 0 640 300" role="img" aria-label="' + ariaFor(current) + '">' +
      '<g class="frag">' + m.draw(m.ph ? BASE : false) + "</g></svg>";
    tint(stage.querySelector(".frag"), color);
    fit(stage.querySelector(".frag"));
    formulaEl.textContent = m.formula;
    noteEl.innerHTML = m.note;
    phBox.hidden = !m.ph;
    updatePh();
  }
  function ariaFor(k) {
    if (k === "phenol") return "苯酚：苯环连接一个羟基";
    if (k === "catechol") return "邻苯二酚：苯环上相邻两个羟基";
    return "酚酞：中心碳连接两个对位羟基苯基与一个邻苯二甲酸内酯环";
  }
  function updatePh() {
    if (!MOL[current].ph) return;
    var ph = parseFloat(phRange.value);
    var frac = Math.min(1, Math.max(0, (ph - 8.2) / (10.0 - 8.2)));
    var next = frac > 0.5;
    if (next !== BASE) {
      BASE = next;
      if (current === "phenolphthalein") swap();
    }
    phSwatch.style.opacity = (0.06 + 0.94 * frac).toFixed(3);
    var name = frac < 0.05 ? "无色" : frac > 0.95 ? "品红" : "浅粉";
    phOut.textContent = "pH " + ph.toFixed(1) + " · " + name + " · " + (BASE ? "醌式二价阴离子" : "内酯式");
  }
  function swap() {
    var frag = stage.querySelector(".frag");
    if (!frag) { paint(); return; }
    var color = BASE ? "var(--fuchsia)" : "var(--ink-2)";
    frag.innerHTML = MOL[current].draw(BASE);
    tint(frag, color);
    fit(frag);
    if (reduce) return;
    spring("mol", 1, function (v) { frag.style.opacity = v; },
           { from: 0.3, response: 0.26, damping: 1, done: function () { frag.style.opacity = ""; } });
  }

  phRange.addEventListener("input", updatePh);

  /* tabs */
  var tabs = document.getElementById("tabs");
  var tabEls = [].slice.call(tabs.querySelectorAll(".tab"));
  var pill = document.getElementById("tab-pill");
  function placePill(el, animate) {
    var g = tabs.getBoundingClientRect(), r = el.getBoundingClientRect();
    var x = r.left - g.left, y = r.top - g.top, w = r.width, h = r.height;
    pill.style.top = y + "px"; pill.style.height = h + "px"; pill.style.opacity = 1;
    if (!animate) { pill.style.transform = "translateX(" + x + "px)"; pill.style.width = w + "px"; return; }
    var m = /translateX\((-?[\d.]+)px\)/.exec(pill.style.transform);
    spring("tpx", x, function (v) { pill.style.transform = "translateX(" + v + "px)"; },
           { from: m ? parseFloat(m[1]) : x, response: 0.32, damping: 1 });
    spring("tpw", w, function (v) { pill.style.width = v + "px"; },
           { from: readPx(pill, "width") || w, response: 0.32, damping: 1 });
  }
  function select(el, animate) {
    tabEls.forEach(function (t) {
      var on = t === el;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
    });
    stage.setAttribute("aria-labelledby", el.id);
    current = el.dataset.mol;
    placePill(el, animate);
    paint();
  }
  tabEls.forEach(function (t) {
    t.addEventListener("click", function () { select(t, true); });
  });
  tabs.addEventListener("keydown", function (e) {
    var i = tabEls.indexOf(document.activeElement);
    if (i < 0) return;
    var j = e.key === "ArrowRight" ? (i + 1) % tabEls.length : e.key === "ArrowLeft" ? (i - 1 + tabEls.length) % tabEls.length : -1;
    if (j < 0) return;
    e.preventDefault();
    tabEls[j].focus();
    select(tabEls[j], true);
  });
  placePill(tabEls[0], false);
  paint();
})();
