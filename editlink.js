/* 顶栏上的「编辑面板」入口，三页共用（首页 / 笔记 / 作品）。
   按钮永远在：它先前只在本机存过口令时才出现，结果第一次用的人根本找不到门，
   连我自己把口令清掉之后都以为没推上去。状态用 /ping 探（那个接口不要求口令）。

   但「永远在」只对站长成立：线上的陌生访客既用不了它，也不该让他们的浏览器
   去敲 127.0.0.1（新版 Chrome 会为此弹「访问本地网络」的权限框）。所以：
     · 页面在本机打开（127.0.0.1 / localhost / file://）—— 照旧永远在；
     · 线上打开 —— 这台浏览器当过站长才出现：存过口令，或者某次用 ?edit 打开过
       （记一个标记，之后不用再带）；?edit=0 把这个标记清掉。
   陌生访客什么都看不到，也不会有任何本机请求。 */
(function () {
  'use strict';
  var KEYNAME = "lab-keeper-key";
  var BASE = "http://127.0.0.1:8720";

  var OWNER = "lab-keeper-owner";

  function hasKey() {
    try { return !!localStorage.getItem(KEYNAME); } catch (e) { return false; }
  }

  function isOwner() {
    var h = location.hostname;
    if (location.protocol === "file:" || h === "127.0.0.1" || h === "localhost" || h === "[::1]") return true;
    try {
      var q = new URLSearchParams(location.search).get("edit");
      if (q === "0") { localStorage.removeItem(OWNER); return false; }
      if (q !== null) localStorage.setItem(OWNER, "1");
      return hasKey() || localStorage.getItem(OWNER) === "1";
    } catch (e) { return false; }
  }

  function boot() {
    var h = document.querySelector("header");
    var anchor = document.getElementById("btnTheme");
    if (!h || !anchor) return;
    if (!isOwner()) return;

    var a = document.createElement("a");
    a.className = "btnlink ed-entry dim";
    a.href = "/note/edit/";
    a.textContent = "编辑面板";
    a.title = "探测本机服务中…";
    h.insertBefore(a, anchor);

    /* 预算页和编辑面板是同一扇门：同样只给站长看，数据同样只在本机服务里 */
    if (location.pathname.indexOf("/note/budget") !== 0) {
      var b = document.createElement("a");
      b.className = "btnlink ed-entry dim";
      b.href = "/note/budget/";
      b.textContent = "预算";
      b.title = "记账和按月分配（数据只在本机）";
      h.insertBefore(b, anchor);
    }
    if (location.pathname.indexOf("/note/calendar") !== 0) {
      var c = document.createElement("a");
      c.className = "btnlink ed-entry dim";
      c.href = "/note/calendar/";
      c.textContent = "日程";
      c.title = "日历（数据只在本机）";
      h.insertBefore(c, anchor);
    }

    function settle(text, title) {
      a.textContent = text;
      a.title = title;
      a.classList.toggle("dim", !hasKey());
      if (b) b.classList.toggle("dim", !hasKey());
      if (c) c.classList.toggle("dim", !hasKey());
    }

    fetch(BASE + "/ping", { cache: "no-store" }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (j) {
      if (!j) return;
      var where = "服务在 :" + (j.port || "?") + " · " + (j.site || "");
      settle(hasKey() ? "编辑面板" : "编辑面板 · 待输口令", where);
    }).catch(function () {
      settle("编辑面板 · 服务未开", "没连上 127.0.0.1:8720 —— 双击 sitekeeper\\start.cmd 后刷新");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
