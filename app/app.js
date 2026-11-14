/* 手机 App：记账 + 日程 + 设置。数据格式和电脑上的预算页、日程页完全一样，
   本机只在 IndexedDB 里存一份加密副本（离线能看能记），联网就经 LabSync 和仓库里的 sync/*.dat 合并。

   快捷指令进来的入口（都只是打开一个网址）：
     /app/#ocr=<截图识别出的文字>      → 认出金额、商家，弹出确认（或开了「自动保存」就直接记）
     /app/#add?amt=12.5&note=xx&kind=out&src=Apple%20Pay  → 直接给字段（钱包交易自动化用）
     /app/#cal                            → 打开日程 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var WD = "一二三四五六日";
  var PALETTE = ["#1f5c9e", "#1f7a3a", "#a15c00", "#8e3b8e", "#b42318", "#0f766e", "#6b6b6b", "#5b4bb7"];
  var REPN = { none: "不重复", daily: "每天", weekdays: "工作日", weekly: "每周", biweekly: "每两周", monthly: "每月", yearly: "每年" };
  var REMN = [["", "不提醒"], ["0", "开始时"], ["5", "提前 5 分钟"], ["10", "提前 10 分钟"], ["15", "提前 15 分钟"],
              ["30", "提前 30 分钟"], ["60", "提前 1 小时"], ["120", "提前 2 小时"], ["1440", "提前 1 天"]];
  var DEFAULT_CATS = [["rent", "房租水电"], ["food", "吃饭"], ["trans", "交通"], ["daily", "日用"],
                      ["study", "学习"], ["fun", "娱乐"], ["save", "存下来", true]];
  var SHORTCUT = "邻苯日程提醒";
  var PREF = "phenol-app-";

  var S = { tab: "money", budget: null, cal: null, month: "", kind: "out", cat: "", days: 60, started: false };

  /* ------------------------------------------------------------ 工具 */
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); }
  function today() { return ymd(new Date()); }
  function thisMonth() { return today().slice(0, 7); }
  function parse(s) { return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
  function add(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return ymd(d); }
  function diff(a, b) { return Math.round((parse(b) - parse(a)) / 864e5); }
  function dow(s) { return (parse(s).getDay() + 6) % 7; }
  function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || "") && ymd(parse(s)) === s; }
  function mins(t) { return t ? (+t.slice(0, 2)) * 60 + (+t.slice(3, 5)) : 0; }
  function hm(m) { m = Math.max(0, Math.min(24 * 60 - 1, m)); return p2(Math.floor(m / 60)) + ":" + p2(m % 60); }
  function shiftMonth(m, k) { var d = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + k, 1); return ymd(d).slice(0, 7); }
  function daysIn(m) { return new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate(); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pref(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(PREF + k);
      if (v === null) localStorage.removeItem(PREF + k); else localStorage.setItem(PREF + k, v);
    } catch (e) {}
    return null;
  }
  function cur() { return (S.budget && S.budget.currency) || "¥"; }
  function fmt(c, sign) {
    var neg = c < 0, v = Math.abs(c) / 100;
    var s = v.toFixed(2).replace(/\.00$/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : sign && c > 0 ? "+" : "") + cur() + s;
  }
  function parseAmt(t) {
    t = String(t || "").replace(/[，,\s¥￥元]/g, "").replace(/[＋]/g, "+").replace(/[－—]/g, "-");
    if (!t) return null;
    if (!/^[-+]?\d*\.?\d+([-+]\d*\.?\d+)*$/.test(t)) return NaN;
    var sum = 0, re = /([-+]?)(\d*\.?\d+)/g, m;
    while ((m = re.exec(t))) sum += (m[1] === "-" ? -1 : 1) * parseFloat(m[2]);
    return Math.round(sum * 100);
  }
  function plain(c) { return (c / 100).toFixed(2).replace(/\.00$/, ""); }
  function nice(s) { var d = parse(s); return (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + WD[dow(s)]; }

  function toast(text, kind, action, ms) {
    var el = $("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
    el.className = "toast" + (kind ? " " + kind : "");
    el.innerHTML = "<span>" + esc(text) + "</span>";
    if (action) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = action.label;
      b.addEventListener("click", function () { el.hidden = true; action.run(); });
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.hidden = true; }, ms || 2600);
  }

  /* ------------------------------------------------------------ 数据形状（和电脑页面一致） */
  function freshB() {
    return { version: 1, currency: "¥",
             categories: DEFAULT_CATS.map(function (c) { return { id: c[0], name: c[1], roll: !!c[2], hidden: false }; }),
             months: {}, tx: [], recurring: [] };
  }
  function normB(d) {
    d = d && typeof d === "object" ? d : freshB();
    d.version = 1;
    d.currency = typeof d.currency === "string" && d.currency ? d.currency : "¥";
    d.categories = Array.isArray(d.categories) ? d.categories : [];
    d.months = d.months && typeof d.months === "object" ? d.months : {};
    d.tx = Array.isArray(d.tx) ? d.tx : [];
    d.recurring = Array.isArray(d.recurring) ? d.recurring : [];
    return d;
  }
  function freshC() {
    return { version: 1, cats: [{ id: "study", name: "学习", color: PALETTE[0] }, { id: "work", name: "工作", color: PALETTE[1] },
                                 { id: "life", name: "生活", color: PALETTE[2] }, { id: "misc", name: "其他", color: PALETTE[6] }],
             events: [], hide: [], show: { notes: true, bills: true, countdown: true } };
  }
  function normC(d) {
    d = d && typeof d === "object" ? d : freshC();
    d.version = 1;
    d.cats = Array.isArray(d.cats) && d.cats.length ? d.cats : freshC().cats;
    d.events = Array.isArray(d.events) ? d.events : [];
    d.hide = Array.isArray(d.hide) ? d.hide : [];
    d.show = d.show && typeof d.show === "object" ? d.show : { notes: true, bills: true, countdown: true };
    return d;
  }

  /* 改了就：存本机加密副本 → 排一次同步 → 重画 */
  function changed(name) {
    var d = name === "budget" ? S.budget : S.cal;
    LabSync.putLocal("local:" + name, d).catch(function () {});
    LabSync.kick(name, 1200);
    render();
  }

  /* ------------------------------------------------------------ 预算计算（照搬电脑页） */
  function catById(id) { return S.budget.categories.filter(function (c) { return c.id === id; })[0] || null; }
  function catName(id) { var c = catById(id); return c ? c.name : "未分类"; }
  function monthTx(mo) { return S.budget.tx.filter(function (t) { return t.d && t.d.slice(0, 7) === mo; }); }
  function allocOf(mo) { var x = S.budget.months[mo]; return (x && x.alloc) || {}; }
  function spentBy(mo) {
    var r = {}, inc = 0, out = 0;
    monthTx(mo).forEach(function (t) {
      if (t.kind === "in") { inc += t.amt; return; }
      out += t.amt;
      r[t.cat || ""] = (r[t.cat || ""] || 0) + t.amt;
    });
    return { cat: r, income: inc, out: out };
  }
  function firstMonth(mo) {
    var f = mo;
    Object.keys(S.budget.months).forEach(function (k) { if (k < f) f = k; });
    S.budget.tx.forEach(function (t) { var k = (t.d || "").slice(0, 7); if (k && k < f) f = k; });
    return f;
  }
  function carryTo(mo) {
    var carry = {}, k = firstMonth(mo), rolls = S.budget.categories.filter(function (c) { return c.roll; });
    while (k < mo) {
      var a = allocOf(k), sp = spentBy(k).cat;
      rolls.forEach(function (c) { carry[c.id] = (carry[c.id] || 0) + (a[c.id] || 0) - (sp[c.id] || 0); });
      k = shiftMonth(k, 1);
    }
    return carry;
  }
  function calc(mo) {
    var a = allocOf(mo), sp = spentBy(mo), carry = carryTo(mo), rows = [], availSum = 0;
    S.budget.categories.forEach(function (c) {
      var al = a[c.id] || 0, ca = c.roll ? (carry[c.id] || 0) : 0, s = sp.cat[c.id] || 0;
      if (c.hidden && !al && !s && !ca) return;
      availSum += al + ca;
      rows.push({ c: c, avail: al + ca, spent: s });
    });
    if (sp.cat[""]) rows.push({ c: { id: "", name: "未分类" }, avail: 0, spent: sp.cat[""] });
    return { rows: rows, availSum: availSum, income: sp.income, out: sp.out };
  }
  function recDone(r, mo) { return S.budget.tx.some(function (t) { return t.rec === r.id && (t.d || "").slice(0, 7) === mo; }); }

  /* ------------------------------------------------------------ 渲染：记账 */
  function renderMoney() {
    var v = $("v-money"), mo = S.month, k = calc(mo);
    var cats = S.budget.categories.filter(function (c) { return !c.hidden; });
    if (S.cat && !catById(S.cat)) S.cat = "";
    var h = '<div class="mon"><button type="button" data-a="prev">‹</button><b>' + (+mo.slice(0, 4)) + " 年 " + (+mo.slice(5, 7)) + " 月</b>" +
      '<button type="button" data-a="next">›</button></div>';
    h += '<div class="tiles"><div><small>支出</small><span class="amt">' + esc(fmt(k.out)) + "</span></div>" +
      "<div><small>收入</small><span class=\"amt\">" + esc(fmt(k.income)) + "</span></div>" +
      "<div><small>预算剩</small><span class=\"amt " + (k.availSum && k.availSum - k.out < 0 ? "neg" : "") + "\">" +
      (k.availSum ? esc(fmt(k.availSum - (k.out - (spentBy(mo).cat[""] || 0)))) : "—") + "</span></div></div>";

    /* 记一笔 */
    h += '<h2>记一笔</h2><form class="card add" id="addf" autocomplete="off">' +
      '<div class="row"><div class="kind" id="kind"><button type="button" data-k="out" class="' + (S.kind === "out" ? "on" : "") + '">支出</button>' +
      '<button type="button" data-k="in" class="' + (S.kind === "in" ? "on" : "") + '">收入</button></div><span class="grow"></span>' +
      '<input type="date" id="a-date" value="' + (mo === thisMonth() ? today() : mo + "-01") + '" style="width:auto;min-height:34px;padding:4px 8px;border-width:1.5px"></div>' +
      '<input class="amtin" id="a-amt" inputmode="decimal" placeholder="0.00" enterkeyhint="done">' +
      (S.kind === "out" ? '<div class="chips" id="a-cats">' + cats.map(function (c) {
        return '<button type="button" class="chip' + (S.cat === c.id ? " on" : "") + '" data-c="' + esc(c.id) + '">' + esc(c.name) + "</button>";
      }).join("") + "</div>" : "") +
      '<div class="row" style="margin-top:10px"><input type="text" id="a-note" class="grow" placeholder="备注（商家、用途）" list="notes" maxlength="60">' +
      '<button class="btn pri" type="submit">记</button></div></form>';
    h += '<datalist id="notes">' + topNotes().map(function (n) { return '<option value="' + esc(n) + '">'; }).join("") + "</datalist>";

    /* 固定收支 */
    var pend = S.budget.recurring.filter(function (r) { return !recDone(r, mo); });
    if (pend.length) {
      h += '<div class="banner warn"><span class="grow">本月还有 ' + pend.length + " 项固定收支没记：" +
        esc(pend.slice(0, 3).map(function (r) { return r.name; }).join("、")) + (pend.length > 3 ? "…" : "") + "</span>" +
        '<button class="btn sm" type="button" data-a="rec">记上</button></div>';
    }

    /* 分类进度 */
    var rows = k.rows.filter(function (r) { return r.avail || r.spent; });
    if (rows.length) {
      h += "<h2>分类</h2><div class=\"card bars\">";
      rows.forEach(function (r) {
        var pct = r.avail > 0 ? Math.min(100, r.spent / r.avail * 100) : (r.spent ? 100 : 0);
        h += '<div class="b"><div class="t"><span>' + esc(r.c.name) + '</span><span class="amt">' + esc(fmt(r.spent)) +
          (r.avail ? ' <span class="dim">/ ' + esc(fmt(r.avail)) + "</span>" : "") + "</span></div>" +
          '<div class="bar"><i style="width:' + pct.toFixed(1) + '%" class="' + (r.avail && r.spent > r.avail ? "over" : !r.avail ? "nobud" : "") + '"></i></div></div>';
      });
      h += "</div>";
    }

    /* 流水 */
    var list = monthTx(mo).slice().sort(function (a, b) {
      return a.d !== b.d ? (a.d < b.d ? 1 : -1) : (b.ts || 0) - (a.ts || 0);
    });
    h += "<h2>流水 <span>" + list.length + " 笔</span></h2><div class=\"list\">";
    if (!list.length) h += '<div class="empty">这个月还没记账</div>';
    var last = "", sums = {};
    list.forEach(function (t) { if (t.kind !== "in") sums[t.d] = (sums[t.d] || 0) + t.amt; });
    list.forEach(function (t) {
      if (t.d !== last) {
        last = t.d;
        h += '<div class="day"><span>' + esc(nice(t.d)) + "</span><span class=\"mono\">" + (sums[t.d] ? esc(fmt(-sums[t.d])) : "") + "</span></div>";
      }
      h += '<div class="it" data-id="' + esc(t.id) + '"><div class="nm">' + esc(t.note || (t.kind === "in" ? "收入" : catName(t.cat))) +
        '<div class="sub">' + esc(t.kind === "in" ? "收入" : catName(t.cat)) + (t.src ? " · " + esc(t.src) : "") + "</div></div>" +
        '<span class="amt ' + (t.kind === "in" ? "pos" : "") + '">' + esc(fmt(t.kind === "in" ? t.amt : -t.amt, true)) + "</span></div>";
    });
    h += "</div>";
    v.innerHTML = h;
  }
  function topNotes() {
    var cnt = {};
    S.budget.tx.slice(-600).forEach(function (t) { if (t.note) cnt[t.note] = (cnt[t.note] || 0) + 1; });
    return Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).slice(0, 30);
  }
  function learned() { return Bills.learn(S.budget.tx); }

  function bindMoney() {
    var v = $("v-money");
    v.addEventListener("click", function (e) {
      var a = e.target.closest("[data-a]"), k = e.target.closest("[data-k]"), c = e.target.closest("[data-c]"), it = e.target.closest(".it");
      if (a) {
        if (a.dataset.a === "prev") { S.month = shiftMonth(S.month, -1); render(); }
        if (a.dataset.a === "next") { S.month = shiftMonth(S.month, 1); render(); }
        if (a.dataset.a === "rec") applyRec();
        return;
      }
      if (k) { keepForm(function () { S.kind = k.dataset.k; }); return; }
      if (c) { keepForm(function () { S.cat = S.cat === c.dataset.c ? "" : c.dataset.c; }); return; }
      if (it) {
        var t = S.budget.tx.filter(function (x) { return x.id === it.dataset.id; })[0];
        if (t) txSheet(t);
      }
    });
    v.addEventListener("submit", function (e) {
      if (e.target.id !== "addf") return;
      e.preventDefault();
      quickAdd();
    });
    v.addEventListener("change", function (e) {
      if (e.target.id === "a-note" && S.kind === "out" && !S.cat) {
        var g = Bills.guessCat(e.target.value, S.budget.categories, learned());
        /* 只改按钮高亮，不重画：这个 change 常常是手指正按在「记」上时触发的，重画会吞掉那次点击 */
        if (g) {
          S.cat = g;
          [].forEach.call(document.querySelectorAll("#a-cats .chip"), function (b) { b.classList.toggle("on", b.dataset.c === g); });
        }
      }
    });
  }
  /* 切换收支 / 分类时重画，但别把正在填的金额和备注冲掉 */
  function keepForm(fn) {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    S.deferred = false;
    var amt = $("a-amt") ? $("a-amt").value : "", note = $("a-note") ? $("a-note").value : "", d = $("a-date") ? $("a-date").value : "";
    fn();
    render();
    if ($("a-amt")) { $("a-amt").value = amt; $("a-note").value = note; if (d) $("a-date").value = d; }
  }
  function quickAdd() {
    var amt = parseAmt($("a-amt").value);
    if (amt === null) { $("a-amt").focus(); toast("先填金额", "bad"); return; }
    if (isNaN(amt) || amt <= 0) { toast("金额看不懂，写数字或者 12+8.5", "bad"); return; }
    var d = $("a-date").value;
    if (!validDate(d)) { toast("日期不对", "bad"); return; }
    var note = $("a-note").value.trim();
    var cat = S.kind === "in" ? "" : (S.cat || Bills.guessCat(note, S.budget.categories, learned()));
    var t = { id: uid(), d: d, amt: amt, kind: S.kind, cat: cat, note: note, ts: Date.now() };
    S.budget.tx.push(t);
    S.cat = "";
    changed("budget");
    toast("记了 " + fmt(amt) + (cat ? " · " + catName(cat) : ""), "", { label: "撤销", run: function () { removeTx(t.id, true); } }, 5000);
  }
  function removeTx(id, silent) {
    var i = S.budget.tx.findIndex(function (t) { return t.id === id; });
    if (i < 0) return;
    var t = S.budget.tx.splice(i, 1)[0];
    changed("budget");
    if (!silent) toast("删了一笔 " + fmt(t.amt), "", { label: "撤销", run: function () { S.budget.tx.push(t); changed("budget"); } }, 5000);
  }
  function applyRec() {
    var n = 0, mo = S.month, dim = daysIn(mo);
    S.budget.recurring.forEach(function (r) {
      if (recDone(r, mo)) return;
      S.budget.tx.push({ id: uid(), d: mo + "-" + p2(Math.min(r.day, dim)), amt: r.amt, kind: r.kind, cat: r.kind === "in" ? "" : r.cat,
                         note: r.name, rec: r.id, ts: Date.now() });
      n++;
    });
    if (n) { changed("budget"); toast("记入了 " + n + " 项固定收支"); }
  }

  /* ------------------------------------------------------------ 弹层 */
  function sheet(html) {
    var m = document.createElement("div");
    m.className = "sheet-mask";
    m.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + html + "</div>";
    document.body.appendChild(m);
    m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
    return m;
  }
  function catChips(sel, cats, attr) {
    return cats.map(function (c) {
      return '<button type="button" class="chip' + (sel === c.id ? " on" : "") + '" ' + attr + '="' + esc(c.id) + '"' +
        (c.color ? ' style="border-color:' + esc(c.color) + '"' : "") + ">" + esc(c.name) + "</button>";
    }).join("");
  }
  /* 改一笔 / 截图进来的一笔，共用一个表单。t 没有 id 就是新的。 */
  function txSheet(t, opts) {
    opts = opts || {};
    var isNew = !t.id, kind = t.kind || "out", cat = t.cat || "";
    var cats = S.budget.categories.filter(function (c) { return !c.hidden || c.id === cat; });
    var m = sheet(
      "<h3>" + (opts.title || (isNew ? "记一笔" : "这一笔")) + '<button type="button" class="link" data-x="close">关闭</button></h3>' +
      (opts.hint ? '<p class="dim small" style="margin:0 0 6px">' + esc(opts.hint) + "</p>" : "") +
      '<div class="row"><div class="kind" id="s-kind"><button type="button" data-k="out" class="' + (kind === "out" ? "on" : "") + '">支出</button>' +
      '<button type="button" data-k="in" class="' + (kind === "in" ? "on" : "") + '">收入</button></div></div>' +
      '<label class="f">金额</label><input type="text" id="s-amt" inputmode="decimal" value="' + (t.amt ? plain(t.amt) : "") + '" class="mono">' +
      '<div id="s-catw"' + (kind === "in" ? " hidden" : "") + '><label class="f">分类</label><div class="chips" id="s-cats" style="margin-top:0">' + catChips(cat, cats, "data-c") + "</div></div>" +
      '<label class="f">备注</label><input type="text" id="s-note" maxlength="60" value="' + esc(t.note || "") + '">' +
      '<div class="two"><div><label class="f">日期</label><input type="date" id="s-date" value="' + esc(t.d || today()) + '"></div>' +
      '<div><label class="f">来源</label><input type="text" id="s-src" maxlength="20" value="' + esc(t.src || "") + '" placeholder="支付宝 / 微信…"></div></div>' +
      '<div class="acts">' + (isNew ? "" : '<button type="button" class="btn danger" data-x="del">删除</button>') +
      '<button type="button" class="btn pri" data-x="save">' + (isNew ? "记上" : "保存") + "</button></div>");
    function q(id) { return m.querySelector("#" + id); }
    m.addEventListener("click", function (e) {
      var k = e.target.closest("[data-k]"), c = e.target.closest("[data-c]"), x = e.target.closest("[data-x]");
      if (k) {
        kind = k.dataset.k;
        [].forEach.call(q("s-kind").children, function (b) { b.classList.toggle("on", b === k); });
        q("s-catw").hidden = kind === "in";
      }
      if (c) {
        cat = cat === c.dataset.c ? "" : c.dataset.c;
        [].forEach.call(q("s-cats").children, function (b) { b.classList.toggle("on", b.dataset.c === cat); });
      }
      if (!x) return;
      if (x.dataset.x === "close") { m.remove(); return; }
      if (x.dataset.x === "del") { m.remove(); removeTx(t.id); return; }
      var amt = parseAmt(q("s-amt").value);
      if (!amt || isNaN(amt) || amt <= 0) { toast("金额看不懂", "bad"); return; }
      var d = q("s-date").value;
      if (!validDate(d)) { toast("日期不对", "bad"); return; }
      var row = isNew ? { id: uid(), ts: Date.now() } : t;
      row.amt = amt; row.kind = kind; row.cat = kind === "in" ? "" : cat; row.note = q("s-note").value.trim(); row.d = d;
      var src = q("s-src").value.trim();
      if (src) row.src = src; else delete row.src;
      if (t.ref) row.ref = t.ref;
      if (isNew) S.budget.tx.push(row);
      m.remove();
      if (d.slice(0, 7) !== S.month) S.month = d.slice(0, 7);
      changed("budget");
      toast((isNew ? "记了 " : "改好了 ") + fmt(amt), "", isNew ? { label: "撤销", run: function () { removeTx(row.id, true); } } : null, 5000);
    });
    if (opts.focusAmt || !t.amt) setTimeout(function () { q("s-amt").focus(); }, 50);
  }

  /* ------------------------------------------------------------ 日程 */
  function catOfC(id) {
    var cs = S.cal.cats;
    for (var i = 0; i < cs.length; i++) if (cs[i].id === id) return cs[i];
    return cs[cs.length - 1];
  }
  function spanOf(ev) { return ev.allDay && ev.end && ev.end > ev.date ? diff(ev.date, ev.end) : 0; }
  function starts(ev, from, to) {
    var out = [], len = spanOf(ev), lo = add(from, -len), d = ev.date, n = 0;
    if (!validDate(d)) return out;
    var until = ev.until && validDate(ev.until) ? ev.until : "9999-12-31", ex = ev.ex || [];
    function push(x) { if (x >= lo && x <= to && x <= until && ex.indexOf(x) < 0) out.push(x); }
    var rep = ev.rep || "none";
    if (rep === "none") { push(d); return out; }
    if (rep === "daily" || rep === "weekdays" || rep === "weekly" || rep === "biweekly") {
      var step = rep === "weekly" ? 7 : rep === "biweekly" ? 14 : 1;
      if (d < lo) { var k = Math.floor(diff(d, lo) / step); d = add(d, k * step); }
      for (; d <= to && d <= until && n < 2000; d = add(d, step), n++) {
        if (d < ev.date) continue;
        if (rep === "weekdays" && dow(d) > 4) continue;
        push(d);
      }
      return out;
    }
    var y = +ev.date.slice(0, 4), mo = +ev.date.slice(5, 7), day = +ev.date.slice(8, 10);
    for (n = 0; n < 1200; n++) {
      var yy = rep === "yearly" ? y + n : y + Math.floor((mo - 1 + n) / 12);
      var mm = rep === "yearly" ? mo : (mo - 1 + n) % 12 + 1;
      var s = yy + "-" + p2(mm) + "-" + p2(day);
      if (s > to || s > until) break;
      if (validDate(s)) push(s);
    }
    return out;
  }
  function instances(from, to) {
    var out = [];
    S.cal.events.forEach(function (ev) {
      if (S.cal.hide.indexOf(ev.cat) >= 0) return;
      var len = spanOf(ev);
      starts(ev, from, to).forEach(function (d) {
        out.push({ ev: ev, d: d, e: add(d, len), all: !!ev.allDay, t: ev.allDay ? "" : ev.start, f: ev.allDay ? "" : ev.finish,
                   title: ev.title, color: catOfC(ev.cat).color });
      });
    });
    /* 预算里的固定收支，只读 */
    if (S.cal.show.bills !== false && S.budget) {
      var m = from.slice(0, 8) + "01";
      for (; m <= to; m = shiftMonth(m.slice(0, 7), 1) + "-01") {
        var dim = daysIn(m.slice(0, 7));
        S.budget.recurring.forEach(function (b) {
          var d = m.slice(0, 8) + p2(Math.min(b.day, dim));
          if (d >= from && d <= to) out.push({ ro: true, d: d, e: d, all: true, title: (b.kind === "in" ? "进账 · " : "付款 · ") + b.name + " " + fmt(b.amt), color: "var(--dim)" });
        });
      }
    }
    out.sort(function (a, b) {
      if (a.d !== b.d) return a.d < b.d ? -1 : 1;
      if (a.all !== b.all) return a.all ? -1 : 1;
      return (a.t || "") < (b.t || "") ? -1 : (a.t || "") > (b.t || "") ? 1 : 0;
    });
    return out;
  }
  function remText(ev) {
    if (ev.remind === undefined || ev.remind === "" || ev.remind === null) return "";
    var r = REMN.filter(function (x) { return x[0] === String(ev.remind); })[0];
    return r ? "🔔 " + r[1].replace("提前 ", "") : "";
  }
  function renderCal() {
    var v = $("v-cal"), from = today(), to = add(from, S.days - 1), items = instances(from, to);
    var h = "";
    var due = reminderPayload(), sent = pref("remsig");
    if (due.items.length && sent !== due.sig) {
      h += '<div class="banner warn"><span class="grow">有 ' + due.items.length + " 个提醒还没推到 iPhone 提醒事项</span>" +
        '<button class="btn sm" type="button" data-a="push">推送</button></div>';
    }
    /* 正在进行中的多天日程要在今天之前就开始，starts() 已经把它们算进来了 */
    var byDay = {};
    items.forEach(function (it) {
      var d = it.d < from ? from : it.d;
      (byDay[d] = byDay[d] || []).push(it);
    });
    var days = Object.keys(byDay).sort();
    if (!days.length) h += '<div class="empty">接下来 ' + S.days + " 天没有日程。点右下角 ＋ 加一个。</div>";
    days.forEach(function (d) {
      var rel = diff(from, d);
      h += '<div class="daygrp' + (rel === 0 ? " today" : "") + '">' + esc(nice(d)) + "<span>" +
        (rel === 0 ? "今天" : rel === 1 ? "明天" : rel === 2 ? "后天" : rel + " 天后") + "</span></div>";
      byDay[d].forEach(function (it) {
        var sub = [];
        if (it.e > it.d) sub.push("到 " + nice(it.e));
        if (it.ev && it.ev.rep && it.ev.rep !== "none") sub.push(REPN[it.ev.rep]);
        if (it.ev) { var r = remText(it.ev); if (r) sub.push(r); }
        if (it.ev && it.ev.note) sub.push(it.ev.note.split("\n")[0].slice(0, 40));
        h += '<div class="ev' + (it.ro ? " ro" : "") + '"' + (it.ev ? ' data-id="' + esc(it.ev.id) + '" data-d="' + it.d + '"' : "") + ">" +
          '<span class="tm">' + (it.all || !it.t ? "全天" : esc(it.t)) + "</span>" +
          '<span class="bar" style="background:' + esc(it.color) + '"></span>' +
          '<div class="nm">' + esc(it.title) + (sub.length ? '<div class="sub">' + esc(sub.join(" · ")) + "</div>" : "") + "</div></div>";
      });
    });
    h += '<p style="text-align:center;margin:18px 0"><button class="btn sm" type="button" data-a="more">再往后看 60 天</button></p>';
    v.innerHTML = h;
  }
  function bindCal() {
    $("v-cal").addEventListener("click", function (e) {
      var a = e.target.closest("[data-a]"), it = e.target.closest(".ev[data-id]");
      if (a && a.dataset.a === "more") { S.days += 60; render(); return; }
      if (a && a.dataset.a === "push") { pushReminders(); return; }
      if (it) {
        var ev = S.cal.events.filter(function (x) { return x.id === it.dataset.id; })[0];
        if (ev) evSheet(ev, it.dataset.d);
      }
    });
    $("fab").addEventListener("click", function () { evSheet(null, today()); });
  }
  function opt(list, sel) {
    return list.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (String(sel) === x[0] ? " selected" : "") + ">" + esc(x[1]) + "</option>"; }).join("");
  }
  function evSheet(ev, occ) {
    var isNew = !ev, e = ev || { title: "", date: occ || today(), allDay: false, start: "09:00", finish: "10:00", rep: "none", cat: S.cal.cats[0].id, remind: "", note: "" };
    var cat = e.cat, rep = e.rep || "none";
    var m = sheet(
      "<h3>" + (isNew ? "新日程" : "日程") + '<button type="button" class="link" data-x="close">关闭</button></h3>' +
      '<label class="f">标题</label><input type="text" id="e-title" maxlength="80" value="' + esc(e.title) + '" placeholder="组会、交作业、看牙……">' +
      '<div class="two"><div><label class="f">日期</label><input type="date" id="e-date" value="' + esc(e.date) + '"></div>' +
      '<div><label class="chk" style="margin-top:34px"><input type="checkbox" id="e-all"' + (e.allDay ? " checked" : "") + "> 全天</label></div></div>" +
      '<div class="two" id="e-times"' + (e.allDay ? " hidden" : "") + '><div><label class="f">开始</label><input type="time" id="e-start" value="' + esc(e.start || "09:00") + '"></div>' +
      '<div><label class="f">结束</label><input type="time" id="e-finish" value="' + esc(e.finish || "10:00") + '"></div></div>' +
      '<div id="e-endw"' + (e.allDay ? "" : " hidden") + '><label class="f">到（多天，可空）</label><input type="date" id="e-end" value="' + esc(e.end || "") + '"></div>' +
      '<label class="f">分类</label><div class="chips" id="e-cats" style="margin-top:0">' + catChips(cat, S.cal.cats, "data-c") + "</div>" +
      '<div class="two"><div><label class="f">重复</label><select id="e-rep">' + opt(Object.keys(REPN).map(function (k) { return [k, REPN[k]]; }), rep) + "</select></div>" +
      '<div><label class="f">提醒</label><select id="e-rem">' + opt(REMN, e.remind == null ? "" : e.remind) + "</select></div></div>" +
      '<div id="e-untilw"' + (rep === "none" ? " hidden" : "") + '><label class="f">重复到（可空）</label><input type="date" id="e-until" value="' + esc(e.until || "") + '"></div>' +
      '<label class="f">备注</label><textarea id="e-note" rows="2" maxlength="2000">' + esc(e.note || "") + "</textarea>" +
      '<div class="acts">' + (isNew ? "" : '<button type="button" class="btn danger" data-x="del">删除</button>') +
      '<button type="button" class="btn pri" data-x="save">' + (isNew ? "加上" : "保存") + "</button></div>");
    function q(id) { return m.querySelector("#" + id); }
    q("e-all").addEventListener("change", function () { q("e-times").hidden = this.checked; q("e-endw").hidden = !this.checked; });
    q("e-rep").addEventListener("change", function () { q("e-untilw").hidden = this.value === "none"; });
    m.addEventListener("click", function (evt) {
      var c = evt.target.closest("[data-c]"), x = evt.target.closest("[data-x]");
      if (c) { cat = c.dataset.c; [].forEach.call(q("e-cats").children, function (b) { b.classList.toggle("on", b.dataset.c === cat); }); }
      if (!x) return;
      if (x.dataset.x === "close") { m.remove(); return; }
      if (x.dataset.x === "del") {
        if (ev.rep && ev.rep !== "none") { m.remove(); delSheet(ev, occ); return; }
        m.remove();
        delEvent(ev);
        return;
      }
      var title = q("e-title").value.trim(), date = q("e-date").value, all = q("e-all").checked;
      if (!title) { toast("写个标题", "bad"); q("e-title").focus(); return; }
      if (!validDate(date)) { toast("日期不对", "bad"); return; }
      var st = q("e-start").value || "09:00", fi = q("e-finish").value, end = q("e-end").value, until = q("e-until").value;
      if (!all && fi && fi <= st) fi = hm(mins(st) + 60);
      var t = ev || { id: uid(), ex: [] };
      t.title = title.slice(0, 80); t.date = date; t.allDay = all;
      t.end = all && end && end > date ? end : "";
      t.start = all ? "" : st; t.finish = all ? "" : (fi || hm(mins(st) + 60));
      t.cat = cat; t.rep = q("e-rep").value; t.until = t.rep === "none" ? "" : (validDate(until) ? until : "");
      t.note = q("e-note").value.trim();
      var rem = q("e-rem").value;
      if (rem === "") delete t.remind; else t.remind = +rem;
      t.ex = t.ex || [];
      if (!ev) S.cal.events.push(t);
      m.remove();
      changed("calendar");
      toast(ev ? "改好了" : "加上了：" + nice(date), "", t.remind !== undefined ? { label: "推到提醒事项", run: pushReminders } : null, 5000);
    });
    if (isNew) setTimeout(function () { q("e-title").focus(); }, 50);
  }
  function delSheet(ev, occ) {
    var m = sheet("<h3>删除重复日程</h3><p>「" + esc(ev.title) + "」是" + esc(REPN[ev.rep]) + "重复的。</p>" +
      '<div class="acts" style="flex-direction:column"><button type="button" class="btn" data-x="one">只删 ' + esc(nice(occ)) + " 这一次</button>" +
      '<button type="button" class="btn danger" data-x="all">删除整个系列</button><button type="button" class="btn" data-x="no">取消</button></div>');
    m.addEventListener("click", function (e) {
      var x = e.target.closest("[data-x]");
      if (!x) return;
      m.remove();
      if (x.dataset.x === "one") { ev.ex = (ev.ex || []).concat([occ]); changed("calendar"); toast("这一次删掉了"); }
      if (x.dataset.x === "all") delEvent(ev);
    });
  }
  function delEvent(ev) {
    var i = S.cal.events.indexOf(ev);
    if (i < 0) return;
    S.cal.events.splice(i, 1);
    changed("calendar");
    toast("删了「" + ev.title + "」", "", { label: "撤销", run: function () { S.cal.events.push(ev); changed("calendar"); } }, 5000);
  }

  /* 提醒：把接下来 30 天要提醒的每一次交给快捷指令，由它写进 iPhone「提醒事项」，到点系统弹窗 */
  function reminderPayload() {
    var from = today(), to = add(from, 30), now = new Date(), items = [];
    if (!S.cal) return { items: [], sig: "" };
    S.cal.events.forEach(function (ev) {
      if (ev.remind === undefined || ev.remind === "" || ev.remind === null) return;
      starts(ev, from, to).forEach(function (d) {
        var t0 = ev.allDay ? "09:00" : (ev.start || "09:00");
        var at = new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), +t0.slice(0, 2), +t0.slice(3, 5));
        at = new Date(at.getTime() - (+ev.remind) * 60000);
        if (at < now) return;
        var stamp = function (x) { return ymd(x) + " " + p2(x.getHours()) + ":" + p2(x.getMinutes()); };
        items.push({ title: ev.title + (ev.allDay ? "" : " " + t0), at: stamp(at),
                     notes: nice(d) + (ev.allDay ? " 全天" : " " + t0 + (ev.finish ? "–" + ev.finish : "")) + (ev.note ? "\n" + ev.note : "") });
      });
    });
    items.sort(function (a, b) { return a.at < b.at ? -1 : 1; });
    items = items.slice(0, 120);
    return { items: items, sig: items.map(function (x) { return x.at + x.title; }).join("|") };
  }
  function pushReminders() {
    var p = reminderPayload();
    if (!p.items.length) { toast("接下来 30 天没有带提醒的日程"); return; }
    pref("remsig", p.sig);
    var text = JSON.stringify({ list: "日程", items: p.items });
    location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent(SHORTCUT) + "&input=text&text=" + encodeURIComponent(text);
    setTimeout(render, 800);
  }

  /* ------------------------------------------------------------ 设置 */
  var syncState = {};
  function renderSet() {
    var base = location.origin + "/app/";
    var h = "<h2>同步</h2><div class=\"card\">" +
      '<div class="it"><span>账本</span><span class="dim small">' + esc(syncState.budget || "…") + "</span></div>" +
      '<div class="it"><span>日程</span><span class="dim small">' + esc(syncState.calendar || "…") + "</span></div>" +
      '<div class="row" style="margin-top:10px"><button class="btn sm" type="button" data-a="now">立即同步</button>' +
      '<button class="btn sm" type="button" data-a="setup">令牌 / 口令</button></div></div>';
    h += "<h2>记账</h2><div class=\"card\">" +
      '<label class="chk" style="margin:0"><input type="checkbox" id="autosave"' + (pref("autosave") === "1" ? " checked" : "") + "> 截图识别出金额就直接记，不用再点确认</label>" +
      '<div class="it"><span>导入支付宝 / 微信账单<div class="dim small">csv 或 xlsx；已经记过的会自动对上，不会重复</div></span>' +
      '<label class="btn sm">选文件<input type="file" id="billfile" accept=".csv,.xlsx,text/csv" hidden></label></div></div>';
    h += '<h2>快捷指令</h2><div class="guide">' +
      "<details><summary>① 付完款轻点手机背面记一笔</summary><ol>" +
      "<li>打开「快捷指令」→ 右上 ＋ 新建，命名 <span class=\"k\">记一笔</span>。</li>" +
      "<li>添加操作 <span class=\"k\">截屏</span>。</li>" +
      "<li>添加操作 <span class=\"k\">从图像中提取文本</span>（输入选上一步的「截屏」）。</li>" +
      "<li>添加操作 <span class=\"k\">URL 编码</span>（输入选「从图像中提取的文本」）。</li>" +
      "<li>添加操作 <span class=\"k\">文本</span>，内容填下面这串，末尾插入变量「URL 编码的文本」：</li></ol>" +
      '<div class="copy"><input type="text" readonly value="' + esc(base + "#ocr=") + '"><button class="btn sm" type="button" data-copy="' + esc(base + "#ocr=") + '">复制</button></div>' +
      "<ol start=\"6\"><li>添加操作 <span class=\"k\">打开 URL</span>（输入选上一步的「文本」）。</li>" +
      "<li>系统「设置」→ 辅助功能 → 触控 → 轻点背面 → 轻点两下 → 选快捷指令「记一笔」。</li></ol>" +
      '<p class="dim small">用法：支付宝 / 微信付款成功页、或账单详情页停在屏幕上时，轻点背面两下。会在 Safari 里打开本页并认出金额和商家。' +
      "第一次要在 Safari 里也连一次同步（主屏图标和 Safari 的存储是分开的）。</p></details>" +
      "<details><summary>② 日程到点弹窗（写进「提醒事项」）</summary><ol>" +
      "<li>先在「提醒事项」App 里建一个列表，名字叫 <span class=\"k\">日程</span>。</li>" +
      "<li>新建快捷指令，名字必须是 <span class=\"k\">" + esc(SHORTCUT) + "</span>。</li>" +
      "<li>添加 <span class=\"k\">获取输入中的词典</span>（输入：快捷指令输入）。</li>" +
      "<li>添加 <span class=\"k\">查找提醒事项</span>：过滤条件「列表 是 日程」且「未完成」，然后添加 <span class=\"k\">删除提醒事项</span>（输入：上一步的提醒事项）。这是为了先清掉旧的，再整批重写，不会重复。</li>" +
      "<li>添加 <span class=\"k\">获取词典值</span>：键 <span class=\"k\">items</span>（词典：第 3 步的词典）。</li>" +
      "<li>添加 <span class=\"k\">重复每一项</span>（输入：上一步的值），在循环里：<br>" +
      "· <span class=\"k\">获取词典值</span> 键 <span class=\"k\">at</span>（词典：重复项目），再接 <span class=\"k\">从输入中获取日期</span>；<br>" +
      "· <span class=\"k\">获取词典值</span> 键 <span class=\"k\">title</span>，和键 <span class=\"k\">notes</span>；<br>" +
      "· <span class=\"k\">添加新提醒事项</span>：标题选 title，列表选「日程」，展开后「提醒」开、日期选上面得到的日期，备注选 notes。</li>" +
      "<li>回到这里，日程页顶上出现「推送」时点一下就行。新加带提醒的日程时，提示条上也有「推到提醒事项」。</li></ol>" +
      '<p class="dim small">提醒事项到点会在锁屏弹出，Apple Watch 也会震。电脑上加的日程，下次打开手机 App 点「推送」就会补上。</p></details>' +
      "<details><summary>③ Apple Pay 刷卡自动记（可选）</summary><ol>" +
      "<li>快捷指令 → 自动化 → 新建 → <span class=\"k\">交易</span>，选你的卡，选「立即运行」。</li>" +
      "<li>添加 <span class=\"k\">文本</span>，填下面这串，在 amt= 后插入「快捷指令输入」的「金额」，note= 后插入「商家」：</li></ol>" +
      '<div class="copy"><input type="text" readonly value="' + esc(base + "#add?src=Apple%20Pay&amt=&note=") + '"><button class="btn sm" type="button" data-copy="' + esc(base + "#add?src=Apple%20Pay&amt=&note=") + '">复制</button></div>' +
      "<ol start=\"3\"><li>添加 <span class=\"k\">打开 URL</span>。</li></ol>" +
      '<p class="dim small">支付宝和微信的通知 iOS 不让快捷指令读，所以那两个只能靠①截图和月底导入账单。</p></details></div>';
    h += '<h2>这台设备</h2><div class="card">' +
      '<div class="it"><span>加到主屏幕</span><span class="dim small">Safari 底部「分享」→「添加到主屏幕」</span></div>' +
      '<div class="it"><span>忘掉这台设备</span><button class="btn sm danger" type="button" data-a="forget">清除</button></div></div>' +
      '<p class="dim small" style="margin-top:14px">数据格式和电脑上的预算页、日程页一样，两边随便改，联网后自动合并。同一条两边都改了的话，以后保存的那台为准。</p>';
    $("v-set").innerHTML = h;
  }
  function bindSet() {
    var v = $("v-set");
    v.addEventListener("click", function (e) {
      var a = e.target.closest("[data-a]"), cp = e.target.closest("[data-copy]");
      if (cp) {
        var t = cp.dataset.copy;
        (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast("复制好了"); }, function () {
          cp.previousElementSibling.select(); toast("长按输入框复制");
        });
        return;
      }
      if (!a) return;
      if (a.dataset.a === "now") { LabSync.syncNow("budget"); LabSync.syncNow("calendar"); }
      if (a.dataset.a === "setup") LabSync.dialog().then(function (ok) { if (ok === "forgot") location.reload(); });
      if (a.dataset.a === "forget") {
        if (!window.confirm("清除这台设备上的令牌、密钥和离线副本？仓库里的数据不受影响。")) return;
        LabSync.forget().then(function () { location.reload(); });
      }
    });
    v.addEventListener("change", function (e) {
      if (e.target.id === "autosave") pref("autosave", e.target.checked ? "1" : null);
      if (e.target.id === "billfile" && e.target.files[0]) { importBill(e.target.files[0]); e.target.value = ""; }
    });
  }

  function importBill(file) {
    Bills.readFile(file).then(function (r) {
      return LabSync.syncNow("budget").catch(function () {}).then(function () { return r; });
    }).then(function (r) {
      if (!r.rows) { toast("认不出这是支付宝还是微信的账单", "bad", null, 4000); return; }
      var rec = Bills.reconcile(r.rows, S.budget.tx), lrn = learned();
      var m = sheet("<h3>导入" + esc(r.src) + "账单</h3>" +
        "<p>共 " + r.rows.length + " 笔：新增 <b>" + rec.add.length + "</b>，和已记的对上 " + rec.match.length + "，重复跳过 " + rec.dup +
        (r.skipped ? "，不计收支 / 已关闭 / 已退款 " + r.skipped : "") + "。</p>" +
        '<p class="dim small">新增的按商家猜分类，以后可以在流水里点开改。</p>' +
        '<div class="acts"><button type="button" class="btn" data-x="no">取消</button><button type="button" class="btn pri" data-x="ok">导入</button></div>');
      m.addEventListener("click", function (e) {
        var x = e.target.closest("[data-x]");
        if (!x) return;
        m.remove();
        if (x.dataset.x !== "ok") return;
        rec.match.forEach(function (p) { if (p.row.ref) p.tx.ref = p.row.ref; if (!p.tx.src) p.tx.src = p.row.src; });
        rec.add.forEach(function (row) {
          var note = row.merchant || row.goods || row.type;
          S.budget.tx.push({ id: uid(), d: row.d, amt: row.amt, kind: row.kind,
                             cat: row.kind === "in" ? "" : Bills.guessCat([row.merchant, row.goods, row.type].join(" "), S.budget.categories, lrn),
                             note: note.slice(0, 60), src: row.src, ref: row.ref, ts: Date.now() });
        });
        changed("budget");
        toast("导入了 " + rec.add.length + " 笔，对上 " + rec.match.length + " 笔", "", null, 4000);
      });
    }).catch(function (e) { toast(e.message || "读不了这个文件", "bad", null, 4000); });
  }

  /* ------------------------------------------------------------ 快捷指令入口 */
  function handleHash() {
    var h = location.hash.slice(1);
    if (!h) return;
    if (h === "cal") { go("cal"); clearHash(); return; }
    if (h.indexOf("ocr=") === 0) {
      var text = "";
      try { text = decodeURIComponent(h.slice(4).replace(/\+/g, " ")); } catch (e) { text = h.slice(4); }
      clearHash();
      fromOcr(text);
      return;
    }
    if (h.indexOf("add?") === 0 || h.indexOf("add&") === 0) {
      var q = new URLSearchParams(h.slice(4));
      clearHash();
      var amt = parseAmt(q.get("amt") || ""), note = (q.get("note") || "").trim();
      var t = { amt: amt > 0 ? amt : 0, kind: q.get("kind") === "in" ? "in" : "out", note: note, src: q.get("src") || "",
                d: Bills.normDate(q.get("date") || "") || today() };
      t.cat = t.kind === "in" ? "" : Bills.guessCat(note, S.budget.categories, learned());
      go("money");
      if (t.amt && pref("autosave") === "1") return autoSave(t);
      txSheet(t, { title: "记一笔", hint: t.src ? "来自 " + t.src : "" });
    }
  }
  function clearHash() { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { location.hash = ""; } }
  function fromOcr(text) {
    go("money");
    var r = Bills.parseOcr(text);
    var t = { amt: isNaN(r.amt) ? 0 : r.amt, kind: r.kind, note: r.merchant || r.goods || "", src: r.src, d: r.d || today() };
    t.cat = t.kind === "in" ? "" : Bills.guessCat([r.merchant, r.goods].join(" "), S.budget.categories, learned());
    if (!t.amt) {
      txSheet(t, { title: "没认出金额", hint: "截图里没找到像金额的数字，手动填一下。", focusAmt: true });
      return;
    }
    /* 同一天、同金额、已经记过的（比如重复截了两次）先提醒一下 */
    var dupe = S.budget.tx.filter(function (x) { return x.d === t.d && x.amt === t.amt && x.kind === t.kind && Date.now() - (x.ts || 0) < 6 * 3600e3; })[0];
    if (t.amt && pref("autosave") === "1" && !dupe) return autoSave(t);
    txSheet(t, { title: "截图记账", hint: dupe ? "今天已经记过一笔同样金额的（" + (dupe.note || "") + "），确认不是重复再记。" :
                 "认出来的，核对一下" + (r.src ? "（" + r.src + "）" : "") });
  }
  function autoSave(t) {
    var row = { id: uid(), d: t.d, amt: t.amt, kind: t.kind, cat: t.cat || "", note: t.note.slice(0, 60), ts: Date.now() };
    if (t.src) row.src = t.src;
    S.budget.tx.push(row);
    changed("budget");
    toast("记了 " + fmt(row.amt) + " " + (row.note || ""), "", { label: "改", run: function () { txSheet(row); } }, 6000);
  }

  /* ------------------------------------------------------------ 框架 */
  function go(tab) {
    S.tab = tab;
    ["money", "cal", "set"].forEach(function (t) { $("v-" + t).hidden = t !== tab; });
    [].forEach.call($("tabs").children, function (b) { b.classList.toggle("on", b.dataset.v === tab); });
    $("title").textContent = { money: "记账", cal: "日程", set: "设置" }[tab];
    $("fab").hidden = tab !== "cal";
    render();
    window.scrollTo(0, 0);
  }
  function render() {
    if (!S.started) return;
    /* 正在输入时同步回来的改动先不重画，免得把光标和输入冲掉；失焦后补一次 */
    var ae = document.activeElement, view = $("v-" + S.tab);
    if (ae && view && view.contains(ae) && /INPUT|TEXTAREA|SELECT/.test(ae.tagName) && ae.type !== "file" && ae.type !== "checkbox") {
      if (!S.deferred) {
        S.deferred = true;
        /* 等一会儿再画：点的是表单里的按钮时，要让那次点击先落地，不然按钮在手指抬起前就被换掉了 */
        ae.addEventListener("blur", function () { setTimeout(function () { if (S.deferred) { S.deferred = false; render(); } }, 400); }, { once: true });
      }
      return;
    }
    if (S.tab === "money") renderMoney();
    if (S.tab === "cal") renderCal();
    if (S.tab === "set") renderSet();
  }
  function paintSync(name, state, msg) {
    syncState[name] = msg;
    syncState["_" + name] = state;
    var st = [syncState._budget, syncState._calendar];
    var cls = st.indexOf("bad") >= 0 ? "bad" : st.indexOf("busy") >= 0 ? "busy" : st.indexOf("off") >= 0 ? "" : st.indexOf("wait") >= 0 ? "" : "ok";
    var b = $("syncbtn");
    b.className = "sync " + cls;
    $("synctxt").textContent = cls === "bad" ? "同步出错" : cls === "busy" ? "同步中" : st.indexOf("wait") >= 0 ? "离线" :
                                st.indexOf("off") >= 0 ? "未连接" : "已同步";
    b.title = (syncState.budget || "") + " / " + (syncState.calendar || "");
    if (S.tab === "set") renderSet();
  }
  function start() {
    $("gate").hidden = true;
    $("app").hidden = false;
    $("tabs").hidden = false;
    return Promise.all([LabSync.getLocal("local:budget"), LabSync.getLocal("local:calendar")]).then(function (a) {
      S.budget = normB(a[0]);
      S.cal = normC(a[1]);
      S.month = thisMonth();
      S.started = true;
      LabSync.attach("budget", {
        get: function () { return S.budget; },
        set: function (d) { S.budget = normB(d); LabSync.putLocal("local:budget", S.budget); render(); },
        normalize: normB,
        isEmpty: function (d) { return !d || (!d.tx.length && !Object.keys(d.months).length && !d.recurring.length); }
      });
      LabSync.attach("calendar", {
        get: function () { return S.cal; },
        set: function (d) { S.cal = normC(d); LabSync.putLocal("local:calendar", S.cal); render(); },
        normalize: normC,
        isEmpty: function (d) { return !d || !d.events.length; }
      });
      go(location.hash === "#cal" ? "cal" : "money");
      handleHash();
    });
  }
  function gate(msg) {
    $("gate").hidden = false;
    $("app").hidden = true;
    $("tabs").hidden = true;
    $("fab").hidden = true;
    $("gatemsg").textContent = msg || "";
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.LabSync || !window.Bills) { document.body.textContent = "脚本没加载全，刷新一下。"; return; }
    LabSync.onStatus(paintSync);
    bindMoney(); bindCal(); bindSet();
    $("tabs").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) go(b.dataset.v); });
    $("syncbtn").addEventListener("click", function () {
      if (!LabSync.isReady()) { LabSync.dialog().then(function (ok) { if (ok === true && !S.started) start(); }); return; }
      LabSync.syncNow("budget"); LabSync.syncNow("calendar");
    });
    $("gatebtn").addEventListener("click", function () {
      LabSync.dialog({ mandatory: true }).then(function (ok) { if (ok === true) start(); });
    });
    window.addEventListener("hashchange", function () { if (S.started) handleHash(); });
    if (!window.isSecureContext) { gate("要用 https 打开（phenolforever.com/app/）。"); return; }
    LabSync.ready().then(function (ok) {
      if (ok) start();
      else gate(location.hash.indexOf("ocr=") === 1 || location.hash.indexOf("add") === 1 ?
                "截图已经带过来了，连上同步以后会接着记。" : "");
    });
    /* 连上之前带着截图进来的：连上后再处理 */
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(function () {});
  });
})();
