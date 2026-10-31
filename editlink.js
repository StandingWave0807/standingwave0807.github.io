/* 笔记列表页上的「编辑笔记」入口。
   只有这台电脑上的本机服务在跑、且口令存在时才出现：它对别人没有任何作用，
   所以路人看到的页面上不留这个按钮，也不留它的痕迹。 */
(function () {
  'use strict';
  var KEYNAME = "lab-keeper-key";
  var BASE = "http://127.0.0.1:8720";

  function boot() {
    var key = null;
    try { key = localStorage.getItem(KEYNAME); } catch (e) {}
    if (!key) return;
    fetch(BASE + "/api/notes", { headers: { "X-Lab-Key": key }, cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (j) {
        var h = document.querySelector("header");
        var anchor = document.getElementById("btnTheme");
        if (!h || !anchor) return;
        var a = document.createElement("a");
        a.className = "btnlink";
        a.href = "/note/edit/";
        a.textContent = "编辑笔记";
        a.title = "本机判题服务已连上，共 " + (j.notes || []).length + " 条笔记";
        h.insertBefore(a, anchor);
      })
      .catch(function () { /* 服务没开就当这个按钮不存在 */ });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
