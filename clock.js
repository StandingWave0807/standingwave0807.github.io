/* 首页时钟与倒计时：时间取自 Date（与 time.is 同一来源），不引第三方脚本 */
(function () {
  'use strict';
  var KEY = "lab-countdown-v1";
  var WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function $(id) { return document.getElementById(id); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function defaultTarget() {
    var now = new Date();
    var y = now.getFullYear();
    var t = new Date(y + 1, 0, 1, 0, 0, 0);
    var thisNewYear = new Date(y, 0, 1, 0, 0, 0);
    if (now < thisNewYear) return thisNewYear;
    return t;
  }
  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || "null");
      if (o && o.target) {
        var d = new Date(o.target);
        if (!isNaN(d)) return { target: d, label: o.label || "倒计时" };
      }
    } catch (e) {}
    return { target: defaultTarget(), label: "新年" };
  }
  function store() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ target: st.target.toISOString(), label: st.label }));
    } catch (e) {}
  }

  var st = load();
  var clockEl = $("clk-time"), dateEl = $("clk-date"), zoneEl = $("clk-zone");
  var dEl = $("cd-d"), hEl = $("cd-h"), mEl = $("cd-m"), sEl = $("cd-s");
  var labelEl = $("cd-label"), inputEl = $("cd-input"), doneEl = $("cd-done");
  if (!clockEl) return;

  var tz = -new Date().getTimezoneOffset() / 60;
  if (zoneEl) zoneEl.textContent = "UTC" + (tz >= 0 ? "+" : "") + (tz % 1 ? tz.toFixed(1) : tz);

  function toLocalInput(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
           "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  if (inputEl) inputEl.value = toLocalInput(st.target);
  if (labelEl) labelEl.textContent = st.label;

  var lastSec = -1;
  function tick() {
    var now = new Date();
    var s = now.getSeconds();
    if (s === lastSec) return;
    lastSec = s;
    clockEl.textContent = pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(s);
    dateEl.textContent = now.getFullYear() + " 年 " + (now.getMonth() + 1) + " 月 " +
                         now.getDate() + " 日 " + WD[now.getDay()];
    var ms = st.target - now;
    var over = ms <= 0;
    if (over) ms = -ms;
    var d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24,
        m = Math.floor(ms / 6e4) % 60, sec = Math.floor(ms / 1e3) % 60;
    dEl.textContent = over ? "+" + d : String(d);
    hEl.textContent = pad(h); mEl.textContent = pad(m); sEl.textContent = pad(sec);
    doneEl.hidden = !over;
    doneEl.textContent = "目标时间已过，显示的是超出天数。";
  }
  if (inputEl) {
    inputEl.addEventListener("change", function () {
      var d = new Date(inputEl.value);
      if (isNaN(d)) { inputEl.value = toLocalInput(st.target); return; }
      st.target = d; store(); lastSec = -1; tick();
    });
  }
  var lbl = $("cd-label-input");
  if (lbl) {
    lbl.value = st.label;
    lbl.addEventListener("input", function () {
      st.label = lbl.value || "倒计时";
      labelEl.textContent = st.label;
      store();
    });
  }
  var rst = $("cd-reset");
  if (rst) {
    rst.addEventListener("click", function () {
      st = { target: defaultTarget(), label: "新年" };
      inputEl.value = toLocalInput(st.target);
      if (lbl) lbl.value = st.label;
      labelEl.textContent = st.label;
      store(); lastSec = -1; tick();
    });
  }
  tick();
  setInterval(tick, 250);
})();
