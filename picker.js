/* 自绘日期时间选择器：datePicker(anchorEl, {value, min, max, onPick})
   点 anchorEl 弹出，选完回调一个 Date。零依赖，样式走站里那套令牌。 */
(function () {
  'use strict';
  var WD = ["一", "二", "三", "四", "五", "六", "日"];
  var open = null;

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  /* 周一为一周之首 */
  function mondayIndex(d) { return (d.getDay() + 6) % 7; }

  function build() {
    var el = document.createElement("div");
    el.className = "dp";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML =
      '<div class="dp-hd">' +
      '<button type="button" class="dp-nav" data-nav="-12" title="上一年">&laquo;</button>' +
      '<button type="button" class="dp-nav" data-nav="-1" title="上一月">&lsaquo;</button>' +
      '<span class="dp-ym"></span>' +
      '<button type="button" class="dp-nav" data-nav="1" title="下一月">&rsaquo;</button>' +
      '<button type="button" class="dp-nav" data-nav="12" title="下一年">&raquo;</button>' +
      "</div>" +
      '<div class="dp-wd">' + WD.map(function (w) { return "<span>" + w + "</span>"; }).join("") + "</div>" +
      '<div class="dp-grid" role="grid"></div>' +
      '<div class="dp-time"><label>时<input type="number" class="dp-hh" min="0" max="23" inputmode="numeric"></label>' +
      '<label>分<input type="number" class="dp-mm" min="0" max="59" inputmode="numeric"></label>' +
      '<button type="button" class="dp-quick" data-hm="00:00">00:00</button>' +
      '<button type="button" class="dp-quick" data-hm="08:00">08:00</button>' +
      '<button type="button" class="dp-quick" data-hm="23:59">23:59</button></div>' +
      '<div class="dp-ft"><button type="button" class="dp-today">今天</button>' +
      '<span class="dp-sp"></span><button type="button" class="dp-cancel">取消</button>' +
      '<button type="button" class="dp-ok">确定</button></div>';
    document.body.appendChild(el);
    return el;
  }

  function close() {
    if (!open) return;
    open.el.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    open = null;
  }

  function onDoc(e) {
    if (!open) return;
    if (open.el.contains(e.target) || (open.anchor && open.anchor.contains(e.target))) return;
    close();
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Enter" && !e.target.matches("input")) { e.preventDefault(); commit(); }
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function hh() { return clamp(parseInt(open.el.querySelector(".dp-hh").value, 10) || 0, 0, 23); }
  function mm() { return clamp(parseInt(open.el.querySelector(".dp-mm").value, 10) || 0, 0, 59); }

  function draw() {
    var el = open.el, cur = open.view, today = new Date();
    el.querySelector(".dp-ym").textContent = cur.getFullYear() + " 年 " + (cur.getMonth() + 1) + " 月";
    var first = new Date(cur.getFullYear(), cur.getMonth(), 1);
    var days = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
    var lead = mondayIndex(first);
    var html = "";
    for (var i = 0; i < lead; i++) html += "<span></span>";
    for (var d = 1; d <= days; d++) {
      var dt = new Date(cur.getFullYear(), cur.getMonth(), d);
      var cls = "dp-d";
      if (sameDay(dt, today)) cls += " today";
      if (sameDay(dt, open.picked)) cls += " sel";
      html += '<button type="button" class="' + cls + '" data-d="' + d + '">' + d + "</button>";
    }
    var grid = el.querySelector(".dp-grid");
    grid.innerHTML = html;
    el.querySelector(".dp-hh").value = pad(hhOf());
    el.querySelector(".dp-mm").value = pad(mmOf());
  }

  function hhOf() { return open.picked.getHours(); }
  function mmOf() { return open.picked.getMinutes(); }

  function setHm(h, m) {
    open.picked = new Date(open.picked.getFullYear(), open.picked.getMonth(), open.picked.getDate(), h, m);
    open.el.querySelector(".dp-hh").value = pad(h);
    open.el.querySelector(".dp-mm").value = pad(m);
    repaintSel();
  }

  function repaintSel() {
    var el = open.el;
    el.querySelectorAll(".dp-d").forEach(function (b) {
      b.classList.toggle("sel", Number(b.dataset.d) === open.picked.getDate() &&
        open.view.getMonth() === open.picked.getMonth() &&
        open.view.getFullYear() === open.picked.getFullYear());
    });
  }

  function commit() {
    var h = clamp(parseInt(open.el.querySelector(".dp-hh").value, 10), 0, 23);
    var m = clamp(parseInt(open.el.querySelector(".dp-mm").value, 10), 0, 59);
    if (isNaN(h)) h = 0;
    if (isNaN(m)) m = 0;
    var d = new Date(open.picked.getFullYear(), open.picked.getMonth(), open.picked.getDate(), h, m);
    var cb = open.onPick;
    close();
    if (cb) cb(d);
  }

  window.datePicker = function (anchor, opts) {
    if (open) { close(); }
    opts = opts || {};
    var start = opts.value instanceof Date && !isNaN(opts.value) ? new Date(opts.value.getTime()) : new Date();
    var el = build();
    open = { el: el, anchor: anchor, view: new Date(start.getFullYear(), start.getMonth(), 1), picked: start, onPick: opts.onPick };

    el.addEventListener("click", function (e) {
      var nav = e.target.closest(".dp-nav");
      if (nav) {
        open.view = new Date(open.view.getFullYear(), open.view.getMonth() + Number(nav.dataset.nav), 1);
        draw(); return;
      }
      var day = e.target.closest(".dp-d");
      if (day) {
        open.picked = new Date(open.view.getFullYear(), open.view.getMonth(), Number(day.dataset.d), hhOf(), mmOf());
        repaintSel(); return;
      }
      var q = e.target.closest(".dp-quick");
      if (q) {
        var p = q.dataset.hm.split(":");
        setHm(Number(p[0]), Number(p[1])); return;
      }
      if (e.target.closest(".dp-today")) {
        var t = new Date();
        open.view = new Date(t.getFullYear(), t.getMonth(), 1);
        open.picked = new Date(t.getFullYear(), t.getMonth(), t.getDate(), hhOf(), mmOf());
        draw(); return;
      }
      if (e.target.closest(".dp-ok")) { commit(); return; }
      if (e.target.closest(".dp-cancel")) { close(); return; }
    });
    el.addEventListener("change", function (e) {
      if (e.target.classList.contains("dp-hh")) e.target.value = pad(clamp(parseInt(e.target.value, 10) || 0, 0, 23));
      if (e.target.classList.contains("dp-mm")) e.target.value = pad(clamp(parseInt(e.target.value, 10) || 0, 0, 59));
      setHm(hh(), mm());
    });

    draw();
    var r = anchor.getBoundingClientRect();
    var w = el.offsetWidth || 268, h = el.offsetHeight || 300;
    var left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left));
    var top = r.bottom + 4;
    if (top + h > window.innerHeight - 6) top = Math.max(6, r.top - h - 4);
    el.style.left = left + "px";
    el.style.top = top + "px";
    setTimeout(function () { document.addEventListener("mousedown", onDoc, true); }, 0);
    document.addEventListener("keydown", onKey, true);
    el.querySelector(".dp-ok").focus();
  };
})();
