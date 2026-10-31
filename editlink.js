/* 顶栏上的「编辑面板」入口，三页共用（首页 / 笔记 / 作品）。
   按钮永远在：它先前只在本机存过口令时才出现，结果第一次用的人根本找不到门，
   连我自己把口令清掉之后都以为没推上去。状态用 /ping 探（那个接口不要求口令）。 */
(function () {
  'use strict';
  var KEYNAME = "lab-keeper-key";
  var BASE = "http://127.0.0.1:8720";

  function hasKey() {
    try { return !!localStorage.getItem(KEYNAME); } catch (e) { return false; }
  }

  function boot() {
    var h = document.querySelector("header");
    var anchor = document.getElementById("btnTheme");
    if (!h || !anchor) return;

    var a = document.createElement("a");
    a.className = "btnlink ed-entry dim";
    a.href = "/note/edit/";
    a.textContent = "编辑面板";
    a.title = "探测本机服务中…";
    h.insertBefore(a, anchor);

    function settle(text, title) {
      a.textContent = text;
      a.title = title;
      a.classList.toggle("dim", !hasKey());
    }

    fetch(BASE + "/ping", { cache: "no-store" }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (j) {
      if (!j) return;
      var where = "服务在 :" + (j.port || "?") + " · " + (j.site || "");
      settle(hasKey() ? "编辑面板 · 已连" : "编辑面板 · 待输口令", where);
    }).catch(function () {
      settle("编辑面板 · 服务未开", "没连上 127.0.0.1:8720 —— 双击 sitekeeper\\start.cmd 后刷新");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
