/* 自绘确认框，替掉浏览器原生的 confirm()。
   复用实验室已有的 .mask / .modal / button.pri 样式，另建一个自己的遮罩层，
   不去占用「编译器设置」那个 #modal，免得两个弹窗互相覆盖内容。
   用法：ask('要覆盖编辑器里的代码吗？').then(y => { if (y) ... })
   或：  ask('问题', {title:'确认', ok:'覆盖', cancel:'算了'})                        */
(function () {
  'use strict';
  var mask = null, done = null;

  function close(v) {
    if (!mask) return;
    mask.classList.remove("show");
    var r = done;
    done = null;
    if (r) r(v);
  }

  function build() {
    var d = document.createElement("div");
    d.className = "mask";
    d.id = "askMask";
    d.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="askT" style="width:min(430px,92vw)">' +
      '<h3 id="askT"></h3><p id="askB" style="margin:0"></p>' +
      '<div class="row"><button id="askNo">取消</button><button class="pri" id="askOk">确定</button></div></div>';
    document.body.appendChild(d);
    d.addEventListener("click", function (e) {
      if (e.target === d) close(false);
      else if (e.target.closest("#askOk")) close(true);
      else if (e.target.closest("#askNo")) close(false);
    });
    document.addEventListener("keydown", function (e) {
      if (!d.classList.contains("show")) return;
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); close(true); }
    });
    return d;
  }

  window.ask = function (question, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      if (!mask) mask = build();
      done = resolve;
      mask.querySelector("#askT").textContent = opts.title || "确认";
      mask.querySelector("#askB").textContent = question;
      mask.querySelector("#askOk").textContent = opts.ok || "确定";
      mask.querySelector("#askNo").textContent = opts.cancel || "取消";
      mask.classList.add("show");
      mask.querySelector("#askOk").focus();
    });
  };
})();
