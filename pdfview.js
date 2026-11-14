/* 笔记页「资源」区的 PDF 预览。
   页面上本来就有「新窗口打开」和「下载」，这里只补一个页内预览：
   - 浏览器能内嵌 PDF 才显示「预览」按钮（手机上多半不能，就只留另外两个）；
   - 5 MB 以下的自动展开，更大的（教材）点了才加载，免得一进页面就拉几十 MB。 */
(function () {
  'use strict';
  var AUTO = 5 * 1024 * 1024;

  function canEmbed() {
    if (typeof navigator.pdfViewerEnabled === "boolean") return navigator.pdfViewerEnabled;
    /* 老浏览器没有这个属性：桌面端基本都能内嵌，触屏小屏基本不能 */
    return !(window.matchMedia && matchMedia("(pointer:coarse)").matches && innerWidth < 820);
  }

  function setup(box) {
    var src = box.getAttribute("data-src");
    var btn = box.querySelector(".pdfview");
    if (!src || !btn || !canEmbed()) return;
    var frame = null;
    btn.hidden = false;
    btn.setAttribute("aria-expanded", "false");

    function show(on) {
      if (on && !frame) {
        frame = document.createElement("iframe");
        frame.className = "pdfframe";
        frame.title = "PDF 预览";
        frame.src = src + "#view=FitH";
        box.appendChild(frame);
      }
      if (frame) frame.hidden = !on;
      btn.textContent = on ? "收起预览" : "预览";
      btn.setAttribute("aria-expanded", on ? "true" : "false");
      box.classList.toggle("open", on);
    }

    btn.addEventListener("click", function () { show(!frame || frame.hidden); });
    var bytes = parseInt(box.getAttribute("data-bytes"), 10);
    if (bytes > 0 && bytes <= AUTO) show(true);
  }

  function boot() {
    [].forEach.call(document.querySelectorAll(".pdfbox[data-src]"), setup);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
