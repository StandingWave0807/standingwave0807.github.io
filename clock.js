/* 首页：时钟、限时计时器、倒数日。时间全部用 Date 自己算，不引第三方脚本。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  var clockEl = $("clk-time"), dateEl = $("clk-date"), zoneEl = $("clk-zone");
  if (!clockEl) return;
  var tz = -new Date().getTimezoneOffset() / 60;
  zoneEl.textContent = "UTC" + (tz >= 0 ? "+" : "") + (tz % 1 ? tz.toFixed(1) : tz);

  /* ---------------- 限时计时器 ---------------- */
  var KEY_T = "lab-timer-v1";
  var tDisp = $("tm-time"), tStatus = $("tm-status"), tMin = $("tm-min"), tSec = $("tm-sec");
  var running = false, endsAt = 0, remain = 0;

  function readInputs() {
    var m = Math.max(0, parseInt(tMin.value, 10) || 0);
    var s = Math.max(0, Math.min(59, parseInt(tSec.value, 10) || 0));
    return (m * 60 + s) * 1000;
  }
  function fmt(ms) {
    var t = Math.max(0, Math.round(ms / 1000)), h = Math.floor(t / 3600),
        m = Math.floor(t / 60) % 60, s = t % 60;
    return (h ? h + ":" : "") + pad(m) + ":" + pad(s);
  }
  function paintTimer() {
    tDisp.textContent = fmt(remain);
    tDisp.classList.toggle("low", running && remain <= 60000);
  }
  function setRunning(on) {
    running = on;
    $("tm-start").textContent = on ? "暂停" : "开始";
    tStatus.textContent = on ? "计时中" : (remain > 0 ? "已暂停" : "已停止");
  }
  function tickTimer() {
    if (!running) return;
    remain = endsAt - Date.now();
    if (remain <= 0) { remain = 0; setRunning(false); tStatus.textContent = "时间到"; }
    paintTimer();
  }
  $("tm-start").addEventListener("click", function () {
    if (running) { remain = Math.max(0, endsAt - Date.now()); setRunning(false); paintTimer(); return; }
    if (remain <= 0) remain = readInputs();
    if (remain <= 0) { tStatus.textContent = "先设一个时长"; return; }
    endsAt = Date.now() + remain;
    setRunning(true);
    tickTimer();
  });
  $("tm-reset").addEventListener("click", function () {
    running = false; remain = readInputs(); setRunning(false); paintTimer();
  });
  [].forEach.call(document.querySelectorAll("[data-min]"), function (b) {
    b.addEventListener("click", function () {
      running = false;
      remain = (+b.dataset.min) * 60000;
      tMin.value = Math.floor(remain / 60000);
      tSec.value = Math.round(remain / 1000) % 60;
      setRunning(false); paintTimer();
      try { localStorage.setItem(KEY_T, String(remain)); } catch (e) {}
    });
  });
  [tMin, tSec].forEach(function (el) {
    el.addEventListener("change", function () {
      if (running) return;
      remain = readInputs(); paintTimer();
      try { localStorage.setItem(KEY_T, String(remain)); } catch (e) {}
    });
  });
  var savedT = +(localStorage.getItem(KEY_T) || 0);
  remain = savedT > 0 ? savedT : 45 * 60000;
  tMin.value = Math.floor(remain / 60000);
  tSec.value = Math.round(remain / 1000) % 60;
  paintTimer();
  setRunning(false);

  /* ---------------- 倒数日 ---------------- */
  var KEY_D = "lab-countdown-v1";
  var dEl = $("cd-d"), hEl = $("cd-h"), mEl = $("cd-m"), sEl = $("cd-s");
  var nameEl = $("cd-label"), inputEl = $("cd-input"), doneEl = $("cd-done");
  var lbl = $("cd-label-input");

  function parseTarget(text) {
    var m = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?\s*$/.exec(text);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    // Date rolls out-of-range fields over into a different valid date, so compare every part back
    var ok = d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] &&
             d.getHours() === +(m[4] || 0) && d.getMinutes() === +(m[5] || 0);
    return ok ? d : null;
  }
  function fmtTarget(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
           " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function newYear() {
    var n = new Date();
    var jan1 = new Date(n.getFullYear(), 0, 1);
    return (n >= jan1 && n < new Date(n.getFullYear(), 0, 2)) ? jan1 : new Date(n.getFullYear() + 1, 0, 1);
  }
  /* 站长在面板里设的日程烘在页面里，所有人打开都是这一个 */
  function baked() {
    var el = document.getElementById("baked-schedule");
    if (!el) return null;
    try {
      var o = JSON.parse(el.textContent || "{}");
      var d = parseTarget(o.target);
      if (!d || !o.label) return null;
      return { target: d, label: String(o.label).slice(0, 12), stamp: o.label + "|" + o.target };
    } catch (e) { return null; }
  }

  var cd = (function () {
    var b = baked();
    try {
      var o = JSON.parse(localStorage.getItem(KEY_D) || "null");
      if (o && o.target) {
        var d = new Date(o.target);
        /* 站长换了日程（stamp 不一样了）就跟上线上；这台机器自己改过的仍然算 */
        if (!isNaN(d.getTime()) && (!b || o.stamp === b.stamp))
          return { target: d, label: o.label || "目标", auto: !o.labelEdited };
      }
    } catch (e) {}
    return b ? { target: b.target, label: b.label, auto: true }
             : { target: newYear(), label: "新年", auto: true };
  })();
  function saveCd() {
    var b = baked();
    try {
      localStorage.setItem(KEY_D, JSON.stringify({
        target: cd.target.toISOString(), label: cd.label, labelEdited: !labelAuto,
        stamp: b ? b.stamp : ""
      }));
    } catch (e) {}
  }
  function reject() {
    inputEl.value = fmtTarget(cd.target);
    inputEl.classList.add("bad");
    setTimeout(function () { inputEl.classList.remove("bad"); }, 900);
  }
  /* 标签没被手动改过时跟着目标走，免得显示"组会 · 50 天"这种自相矛盾；
     "改没改过"存成标记，不能靠文字内容猜 */
  var labelAuto = cd.auto !== false;
  function setLabel(v, auto) {
    cd.label = v; labelAuto = !!auto;
    lbl.value = v; nameEl.textContent = v;
  }
  function applyTarget(d) {
    cd.target = d;
    inputEl.value = fmtTarget(d);
    if (labelAuto) setLabel((d.getMonth() + 1) + " 月 " + d.getDate() + " 日", true);
    saveCd(); tickCd();
  }
  inputEl.value = fmtTarget(cd.target);
  lbl.value = cd.label;
  nameEl.textContent = cd.label;
  lbl.addEventListener("input", function () {
    setLabel(lbl.value || "目标", false); saveCd();
  });
  inputEl.addEventListener("change", function () {
    var d = parseTarget(inputEl.value);
    if (!d) { reject(); return; }
    applyTarget(d);
  });
  var pickBtn = $("cd-pick");
  if (pickBtn) pickBtn.addEventListener("click", function () {
    var cur = parseTarget(inputEl.value) || cd.target;
    window.datePicker(pickBtn, {
      value: cur,
      onPick: function (d) { applyTarget(d); }
    });
  });
  $("cd-newyear").addEventListener("click", function () {
    cd.target = newYear();
    inputEl.value = fmtTarget(cd.target);
    setLabel("新年", true);
    saveCd(); tickCd();
  });

  function tickCd() {
    var now = new Date();
    clockEl.textContent = pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
    dateEl.textContent = now.getFullYear() + " 年 " + (now.getMonth() + 1) + " 月 " + now.getDate() + " 日 " + WD[now.getDay()];
    var ms = cd.target - now, over = ms <= 0, abs = over ? -ms : ms;
    dEl.textContent = Math.floor(abs / 864e5);
    hEl.textContent = pad(Math.floor(abs / 36e5) % 24);
    mEl.textContent = pad(Math.floor(abs / 6e4) % 60);
    sEl.textContent = pad(Math.floor(abs / 1e3) % 60);
    /* 过了就只报"过了多久"，时/分/秒继续走没有意义 */
    hEl.parentElement.hidden = over;
    mEl.parentElement.hidden = over;
    sEl.parentElement.hidden = over;
    doneEl.hidden = !over;
    doneEl.textContent = over
      ? (Math.floor(abs / 864e5) > 0 ? "已过 " + Math.floor(abs / 864e5) + " 天" : "到点了")
      : "";
  }
  tickCd();
  setInterval(function () { tickCd(); tickTimer(); }, 200);
})();
