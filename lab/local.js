/* 网站上的实验室用相对路径调本机判题接口（/ping、/api/*）。
   页面挂在 https://phenolforever.com 上，相对路径会打到网站自己，够不着 127.0.0.1，
   所以这里把它们改写成本机服务的绝对地址。地址可用 ?base= 或 localStorage['cpplab2-base'] 改。
   在线判题（wandbox.js）和页面本身就在本机时都不接管。 */
(function () {
  'use strict';
  var KEY = "cpplab2-base";
  var DEF = "http://127.0.0.1:8710";

  function on() {
    try { return localStorage.getItem("lab-online") === "1"; } catch (e) { return false; }
  }
  if (on()) return;

  var h = location.hostname;
  if (location.protocol === "file:" || h === "127.0.0.1" || h === "localhost" || h === "[::1]") return;

  var base = DEF;
  try {
    var q = new URLSearchParams(location.search).get("base");
    if (q) base = q;
    else {
      var s = localStorage.getItem(KEY);
      if (s) base = s;
    }
  } catch (e) {}
  base = String(base).replace(/\/+$/, "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)) base = DEF;

  var real = window.fetch.bind(window);
  window.fetch = function (url, opt) {
    var u = String(url);
    if (/^\/(ping|api\/)/.test(u)) u = base + u;
    return real(u, opt);
  };

  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("btnLocal");
    if (!b) return;
    function paint(alive) {
      b.textContent = alive ? "本机判题 已连上" : "本机判题 未连上";
      b.style.background = alive ? "var(--fg)" : "";
      b.style.color = alive ? "var(--bg)" : "";
      b.title = base + "/ping —— 关掉服务窗口即断开";
    }
    paint(false);
    b.addEventListener("click", function () {
      fetch("/ping", { cache: "no-store" })
        .then(function (r) { return r.text(); })
        .then(function (t) { paint(t === "cpplab2"); })
        .catch(function () { paint(false); });
    });
  });
})();
