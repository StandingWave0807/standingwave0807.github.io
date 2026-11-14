/* 公式面板：写 LaTeX 时边写边看渲染结果，点符号就插进去。
     FormulaPanel.open({ anchor: 按钮或编辑区, tex: "已有公式", display: true/false,
                         editing: true/false, onDone: function (tex, display) {...} })
   面板不管文档怎么改，只把写好的 LaTeX 和「行内 / 整段」交回去，由 edit.js 落到正文里。
   模板里的 ◻ 是占位格：插入后自动选中第一个，Tab 跳到下一个。 */
(function () {
  "use strict";
  var B = String.fromCharCode(92);
  var BOX = "◻";
  var RECENT = "fx-recent";

  function T(s) { return s.replace(/@/g, B); }   /* 模板里用 @ 代替反斜杠，好读些 */

  var GROUPS = [
    { name: "结构", items: [
      ["分式", "@frac{◻}{◻}"], ["上标", "◻^{◻}"], ["下标", "◻_{◻}"], ["根号", "@sqrt{◻}"],
      ["n 次根", "@sqrt[◻]{◻}"], ["求和", "@sum_{◻}^{◻}"], ["积分", "@int_{◻}^{◻}"],
      ["极限", "@lim_{◻ @to ◻}"], ["偏导", "@frac{@partial ◻}{@partial ◻}"], ["导数", "@frac{d◻}{d◻}"],
      ["向量", "@vec{◻}"], ["帽子", "@hat{◻}"], ["上划线", "@overline{◻}"], ["括号", "@left( ◻ @right)"],
      ["绝对值", "@left| ◻ @right|"], ["范数", "@lVert ◻ @rVert"], ["文字", "@text{◻}"], ["粗体", "@mathbf{◻}"]
    ] },
    { name: "矩阵", items: [
      ["2×2", "@begin{pmatrix} ◻ & ◻ @@ ◻ & ◻ @end{pmatrix}"],
      ["3×3", "@begin{pmatrix} ◻ & ◻ & ◻ @@ ◻ & ◻ & ◻ @@ ◻ & ◻ & ◻ @end{pmatrix}"],
      ["行列式", "@begin{vmatrix} ◻ & ◻ @@ ◻ & ◻ @end{vmatrix}"],
      ["方括号", "@begin{bmatrix} ◻ & ◻ @@ ◻ & ◻ @end{bmatrix}"],
      ["分段", "@begin{cases} ◻ & ◻ @@ ◻ & ◻ @end{cases}"],
      ["多行对齐", "@begin{aligned} ◻ &= ◻ @@ &= ◻ @end{aligned}"],
      ["省略", "@cdots"], ["竖省略", "@vdots"], ["斜省略", "@ddots"]
    ] },
    { name: "希腊", items: "alpha beta gamma delta epsilon varepsilon zeta eta theta lambda mu nu xi pi rho sigma tau phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega"
      .split(" ").map(function (g) { return [g, "@" + g]; }) },
    { name: "符号", items: [
      ["≤", "@le"], ["≥", "@ge"], ["≠", "@ne"], ["≈", "@approx"], ["≡", "@equiv"], ["∝", "@propto"],
      ["×", "@times"], ["·", "@cdot"], ["±", "@pm"], ["∞", "@infty"], ["∂", "@partial"], ["∇", "@nabla"],
      ["∈", "@in"], ["∉", "@notin"], ["⊂", "@subset"], ["⊆", "@subseteq"], ["∪", "@cup"], ["∩", "@cap"],
      ["∀", "@forall"], ["∃", "@exists"], ["→", "@to"], ["⇒", "@Rightarrow"], ["⇔", "@iff"], ["↦", "@mapsto"],
      ["ℝ", "@mathbb{R}"], ["ℂ", "@mathbb{C}"], ["ℕ", "@mathbb{N}"], ["ℤ", "@mathbb{Z}"], ["转置", "^{@mathsf T}"], ["∘", "@circ"]
    ] }
  ];

  var el = null, ta, pv, err, tabs, pal, recentBox, modeBtns, okBtn, done = null, group = 0, display = false, timer = null;

  function $(s) { return el.querySelector(s); }

  function build() {
    el = document.createElement("div");
    el.className = "fx";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "公式");
    el.hidden = true;
    el.innerHTML =
      '<div class="fx-head"><b class="fx-title">插入公式</b>' +
      '<div class="fx-mode" role="tablist">' +
      '<button type="button" data-d="0" title="跟在文字中间，$…$">行内</button>' +
      '<button type="button" data-d="1" title="单独一行居中，$$…$$">整段</button></div>' +
      '<span class="sp"></span><button type="button" class="fx-x" title="关掉（Esc）">×</button></div>' +
      '<textarea class="fx-in" rows="2" spellcheck="false" autocomplete="off" placeholder="写 LaTeX，比如 ' + T("@frac{a}{b}") + '"></textarea>' +
      '<div class="fx-pv" aria-live="polite"></div>' +
      '<div class="fx-err" hidden></div>' +
      '<div class="fx-tabs"></div><div class="fx-pal"></div>' +
      '<div class="fx-recent" hidden></div>' +
      '<div class="fx-foot"><span class="note">Tab 跳下一个 ◻ · Ctrl+Enter 插入 · Esc 关掉</span>' +
      '<span class="sp"></span><button type="button" class="fx-no">取消</button>' +
      '<button type="button" class="pri fx-ok">插入</button></div>';
    document.body.appendChild(el);
    ta = $(".fx-in"); pv = $(".fx-pv"); err = $(".fx-err"); tabs = $(".fx-tabs"); pal = $(".fx-pal");
    recentBox = $(".fx-recent"); okBtn = $(".fx-ok");
    modeBtns = el.querySelectorAll(".fx-mode button");

    GROUPS.forEach(function (g, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = g.name;
      b.onclick = function () { group = i; paintPal(); ta.focus(); };
      tabs.appendChild(b);
    });
    modeBtns.forEach(function (b) {
      b.onclick = function () { setMode(b.dataset.d === "1"); ta.focus(); };
    });
    $(".fx-x").onclick = function () { close(null); };
    $(".fx-no").onclick = function () { close(null); };
    okBtn.onclick = submit;
    ta.addEventListener("input", function () { grow(); clearTimeout(timer); timer = setTimeout(render, 60); });
    ta.addEventListener("keydown", key);
    /* 点符号按钮时别让输入框丢光标位置 */
    el.addEventListener("mousedown", function (e) {
      if (e.target.closest(".fx-pal button, .fx-recent button")) e.preventDefault();
    });
    document.addEventListener("mousedown", function (e) {
      if (!el.hidden && !el.contains(e.target) && !e.target.closest("[data-fx-keep]")) close(null);
    }, true);
    window.addEventListener("resize", function () { if (!el.hidden) place(lastAnchor); });
  }

  function katexOk() { return !!window.katex; }

  function glyph(btn, tex, label) {
    var show = tex.replace(/◻/g, B + "square");
    if (katexOk()) {
      try { window.katex.render(show, btn, { throwOnError: true, displayMode: false }); btn.title = label + "　" + tex.replace(/◻/g, "□"); return; }
      catch (e) { /* 渲染不了就退回文字 */ }
    }
    btn.textContent = label;
    btn.title = tex.replace(/◻/g, "□");
  }

  function paintPal() {
    tabs.querySelectorAll("button").forEach(function (b, i) { b.classList.toggle("on", i === group); });
    pal.innerHTML = "";
    pal.className = "fx-pal" + (group === 0 || group === 1 ? " wide" : "");
    GROUPS[group].items.forEach(function (it) {
      var b = document.createElement("button");
      b.type = "button";
      var tex = T(it[1]);
      glyph(b, tex, it[0]);
      b.onclick = function () { put(tex); };
      pal.appendChild(b);
    });
  }

  function paintRecent() {
    var list = recent();
    recentBox.hidden = !list.length;
    recentBox.innerHTML = list.length ? '<span class="note">最近用过</span>' : "";
    list.forEach(function (tex) {
      var b = document.createElement("button");
      b.type = "button";
      glyph(b, tex, tex.length > 18 ? tex.slice(0, 18) + "…" : tex);
      b.onclick = function () { put(tex); };
      recentBox.appendChild(b);
    });
  }

  function recent() {
    try { return JSON.parse(localStorage.getItem(RECENT) || "[]"); } catch (e) { return []; }
  }
  function remember(tex) {
    var list = recent().filter(function (t) { return t !== tex; });
    list.unshift(tex);
    try { localStorage.setItem(RECENT, JSON.stringify(list.slice(0, 8))); } catch (e) { }
  }

  /* 把一段（可能带 ◻ 的）LaTeX 放到光标处；有选中内容就塞进第一个 ◻ */
  function put(tex) {
    var a = ta.selectionStart, z = ta.selectionEnd, v = ta.value;
    var sel = v.slice(a, z);
    if (sel && sel !== BOX && tex.indexOf(BOX) >= 0) tex = tex.replace(BOX, sel);
    var before = v.slice(0, a), after = v.slice(z);
    /* 命令后面紧跟字母会粘成别的命令（\alphax），补个空格 */
    if (/\\[a-zA-Z]+$/.test(tex) && /^[a-zA-Z]/.test(after)) tex += " ";
    ta.value = before + tex + after;
    var box = ta.value.indexOf(BOX, a);
    if (box >= 0 && box < a + tex.length) ta.setSelectionRange(box, box + 1);
    else ta.setSelectionRange(a + tex.length, a + tex.length);
    ta.focus();
    grow();
    render();
  }

  function nextBox(back) {
    var v = ta.value, i;
    if (back) {
      i = v.lastIndexOf(BOX, Math.max(0, ta.selectionStart - 1));
      if (i < 0) i = v.lastIndexOf(BOX);
    } else {
      i = v.indexOf(BOX, ta.selectionEnd);
      if (i < 0) i = v.indexOf(BOX);
    }
    if (i < 0) return false;
    ta.setSelectionRange(i, i + 1);
    return true;
  }

  function key(e) {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); close(null); }
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); submit(); }
    else if (e.key === "Enter" && !display && !e.shiftKey) { e.preventDefault(); submit(); }   /* 行内公式不该换行 */
    else if (e.key === "Tab") {
      if (nextBox(e.shiftKey)) { e.preventDefault(); }
      else if (!e.shiftKey) { e.preventDefault(); okBtn.focus(); }
    }
  }

  function grow() {
    ta.style.height = "auto";
    ta.style.height = Math.min(220, ta.scrollHeight + 4) + "px";
  }

  function render() {
    var tex = ta.value.trim();
    err.hidden = true;
    if (!tex) { pv.innerHTML = '<span class="note">渲染结果在这里</span>'; okBtn.disabled = true; return; }
    okBtn.disabled = false;
    if (!katexOk()) { pv.textContent = tex; return; }
    var show = tex.replace(/◻/g, B + "square");
    try {
      window.katex.render(show, pv, { displayMode: display, throwOnError: true });
    } catch (x) {
      window.katex.render(show, pv, { displayMode: display, throwOnError: false });
      err.textContent = "写法有问题：" + String(x.message || x).replace(/^KaTeX parse error:\s*/, "");
      err.hidden = false;
    }
    if (tex.indexOf(BOX) >= 0) {
      err.textContent = (err.hidden ? "" : err.textContent + "　") + "还有 ◻ 没填（Tab 跳过去）";
      err.hidden = false;
    }
  }

  function setMode(d) {
    display = !!d;
    modeBtns.forEach(function (b) { b.classList.toggle("on", (b.dataset.d === "1") === display); });
    ta.rows = display ? 3 : 2;
    grow();
    render();
  }

  var lastAnchor = null;
  function place(anchor) {
    lastAnchor = anchor;
    var r = anchor ? anchor.getBoundingClientRect() : { left: 40, bottom: 80, top: 80 };
    var w = Math.min(460, window.innerWidth - 16);
    el.style.width = w + "px";
    var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    var top = r.bottom + 6;
    var h = el.offsetHeight || 420;
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function open(o) {
    if (!el) build();
    o = o || {};
    done = o.onDone || null;
    ta.value = o.tex || "";
    $(".fx-title").textContent = o.editing ? "改公式" : "插入公式";
    okBtn.textContent = o.editing ? "改好了" : "插入";
    paintPal();
    paintRecent();
    el.hidden = false;
    setMode(!!o.display);
    place(o.anchor);
    ta.focus();
    if (!nextBox(false)) ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function submit() {
    var tex = ta.value.trim();
    if (!tex) return;
    remember(tex.replace(/\s*\n\s*/g, " "));
    var cb = done;
    close(true);
    if (cb) cb(tex, display);
  }

  function close(ok) {
    if (!el || el.hidden) return;
    el.hidden = true;
    var cb = done;
    done = null;
    if (!ok && cb && cb.cancel) cb.cancel();
  }

  window.FormulaPanel = { open: open, close: function () { close(null); }, isOpen: function () { return !!el && !el.hidden; } };
})();
