/* 顶栏的当前时间。首页不挂（它已经有「此刻」那一块），其余页面都挂。
   放在 #btnTheme 前面；没有这颗按钮的页面就什么也不做，不留半个空框。 */
(function () {
  'use strict';
  var WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function p(n) { return (n < 10 ? "0" : "") + n; }

  function boot() {
    var h = document.querySelector("header");
    var anchor = document.getElementById("btnTheme");
    if (!h || !anchor) return;

    var s = document.createElement("span");
    s.className = "passcount mono";
    s.id = "hdr-clock";
    s.title = "这台电脑的本地时间";
    h.insertBefore(s, anchor);

    function tick() {
      var d = new Date();
      s.textContent = (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + WD[d.getDay()] +
                      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }
    tick();
    /* 页面在后台时不必走秒，切回来再对齐 */
    setInterval(function () { if (!document.hidden) tick(); }, 1000);
    document.addEventListener("visibilitychange", tick);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
