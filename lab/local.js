/* 网站上的实验室用相对路径调本机判题接口（/ping、/api/*）。
   页面挂在 https://phenolforever.com 上，相对路径会打到网站自己，够不着 127.0.0.1，
   所以这里把它们改写成本机服务的绝对地址。地址可用 ?base= 或 localStorage['cpplab2-base'] 改。
   在线判题（wandbox.js）和页面本身就在本机时都不接管。 */
(function () {
  'use strict';
  var KEY = "cpplab2-base";
  var DEF = "http://127.0.0.1:8710";
  var TOKEN = "cpplab2";

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
  // 只准指向本机端口，免得 ?base= 把代码发去别的主机
  if (!/^https?:\/\/(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(:\d{1,5})?$/.test(base)) base = DEF;

  var alive = false;
  function paint(v) {
    alive = v;
    var b = document.getElementById("btnLocal");
    if (!b) return;
    b.textContent = v ? "本机判题 已连上" : "本机判题 未连上";
    b.style.background = v ? "var(--fg)" : "";
    b.style.color = v ? "var(--bg)" : "";
    b.title = base + "/ping —— 关掉服务窗口即断开";
  }

  var real = window.fetch.bind(window);
  window.fetch = function (url, opt) {
    var u = String(url);
    if (/^\/(ping|api\/)/.test(u)) u = base + u;
    var p = real(u, opt);
    // 页面每次探活都顺手把开关的状态刷新，这里不额外发请求
    if (u.indexOf("/ping") >= 0) {
      p.then(function (r) {
        r.clone().text().then(function (t) { paint(r.ok && t === TOKEN); }, function () {});
      }, function () { paint(false); });
    }
    return p;
  };

  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("btnLocal");
    if (!b) return;
    paint(alive);
    b.addEventListener("click", function () {
      real(base + "/ping", { cache: "no-store" })
        .then(function (r) { return r.text(); })
        .then(function (t) { paint(t === TOKEN); }, function () { paint(false); });
    });
  });
})();
