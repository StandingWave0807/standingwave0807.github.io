/* 两个实验室都用相对路径调本机判题接口（/ping、/api/*）。
   页面挂在 https://phenolforever.com 上，相对路径会打到网站自己，够不着 127.0.0.1，
   所以这里把它们改写成本机服务的绝对地址。参数从自己的 <script> 标签上读：
     data-token  /ping 应该回什么（默认 cpplab2）
     data-port   本机服务端口（默认 8710）
     data-key    localStorage 里存自定义地址的键
     data-online =1 时，访问者开了「在线判题」就不接管（只有 C++ 那页有这档）
   地址还可以用 ?base= 临时改；页面本身在本机或 file:// 打开时不接管。 */
(function () {
  'use strict';
  var tag = document.currentScript;
  if (!tag) {
    var all = document.getElementsByTagName("script");
    for (var k = 0; k < all.length; k++) {
      if (/local\.js/.test(all[k].src)) { tag = all[k]; break; }
    }
  }
  var ds = (tag && tag.dataset) || {};
  var TOKEN = ds.token || "cpplab2";
  var DEF = "http://127.0.0.1:" + (ds.port || "8710");
  var KEY = ds.key || "cpplab2-base";

  if (ds.online === "1") {
    try { if (localStorage.getItem("lab-online") === "1") return; } catch (e) {}
  }

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
