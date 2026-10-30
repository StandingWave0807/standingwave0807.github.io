/* 自绘对话框，替掉浏览器原生的 confirm() / prompt()。
   复用实验室已有的 .mask / .modal / button.pri 样式，另建自己的遮罩层，
   不去占用「编译器设置」那个 #modal，免得两个弹窗互相覆盖内容。
     ask('要覆盖编辑器里的代码吗？').then(y => { if (y) ... })
     askText('解锁', '请输入本机服务口令', {ok:'解锁'}).then(r => { if (r.ok) use(r.value) })
   两个函数都返回 Promise。 */
(function () {
  'use strict';
  var mask = null, done = null;
  var SANS = '-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';

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
      '<div id="askWrap" hidden><input id="askI" type="text" autocomplete="off" spellcheck="false"></div>' +
      '<div id="askErr" class="note" hidden></div>' +
      '<div class="row"><button type="button" id="askNo">取消</button>' +
      '<button type="button" class="pri" id="askOk">确定</button></div></div>';
    document.body.appendChild(d);
    d.addEventListener("click", function (e) {
      if (e.target === d) close(null);
      else if (e.target.closest("#askOk")) submit(d);
      else if (e.target.closest("#askNo")) close(null);
    });
    document.addEventListener("keydown", function (e) {
      if (!d.classList.contains("show")) return;
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); submit(d); }
    });
    return d;
  }

  function submit(d) {
    var wantText = d.querySelector("#askWrap").hidden === false;
    if (!wantText) { close(true); return; }
    var v = d.querySelector("#askI").value.trim();
    if (!v) { showErr(d, "不能为空"); return; }
    close({ ok: true, value: v });
  }

  function showErr(d, msg) {
    var e = d.querySelector("#askErr");
    e.textContent = msg;
    e.hidden = false;
  }

  function open(opts, question, wantText, initial) {
    if (!mask) mask = build();
    mask.querySelector("#askT").textContent = opts.title || "确认";
    mask.querySelector("#askB").textContent = question;
    mask.querySelector("#askOk").textContent = opts.ok || "确定";
    mask.querySelector("#askNo").textContent = opts.cancel || "取消";
    var wrap = mask.querySelector("#askWrap");
    var err = mask.querySelector("#askErr");
    var input = mask.querySelector("#askI");
    wrap.hidden = !wantText;
    err.hidden = true;
    if (wantText) {
      input.type = opts.password ? "password" : "text";
      input.value = initial || "";
    }
    mask.classList.add("show");
    setTimeout(function () { (wantText ? input : mask.querySelector("#askOk")).focus(); }, 0);
  }

  window.ask = function (question, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      done = function (v) { resolve(!!v); };
      open(opts, question, false, null);
    });
  };

  window.askText = function (title, question, opts) {
    opts = opts || {};
    opts.title = title || opts.title;
    return new Promise(function (resolve) {
      done = function (v) {
        resolve(v && v.ok ? { ok: true, value: v.value } : { ok: false, value: "" });
      };
      open(opts, question, true, opts.value || "");
    });
  };

  /* 输入框跟着这套版式走，不留浏览器默认样式 */
  var st = document.createElement("style");
  st.textContent = '#askMask input{width:100%;margin-top:10px;border:2px solid var(--line);' +
    'background:var(--bg);color:var(--fg);font:14px/1.6 ' + SANS + ';padding:6px 9px}' +
    '#askMask input:focus{outline:2px solid var(--fg);outline-offset:1px}' +
    '#askMask .note{color:var(--bad);margin-top:8px;font-size:12.5px}';
  document.addEventListener("DOMContentLoaded", function () { document.head.appendChild(st); });
})();
