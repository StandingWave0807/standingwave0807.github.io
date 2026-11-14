/* 预算页：记账 + 按月分配。
   数据只经本机服务读写（sitekeeper/data/budget.json，仓库外），浏览器里只记口令和几个界面偏好，
   不在 localStorage 里留任何金额。金额一律以「分」存整数，免得 0.1 + 0.2 的问题。 */
(function () {
  'use strict';

  var KEYNAME = "lab-keeper-key";          /* 和编辑面板共用同一个口令 */
  var MASKKEY = "lab-bg-mask";
  var BASE = (function () {
    try {
      var q = new URLSearchParams(location.search).get("keeper");
      if (q && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(q)) return q;
    } catch (e) {}
    return "http://127.0.0.1:8720";
  })();
  var START_HINT = /Win/.test(navigator.platform || navigator.userAgent)
    ? "双击 sitekeeper\\start.cmd，" : "在终端里跑 python sitekeeper/keeper.py，";
  var DEFAULT_CATS = [["rent", "房租水电"], ["food", "吃饭"], ["trans", "交通"], ["daily", "日用"],
                      ["study", "学习"], ["fun", "娱乐"], ["save", "存下来", true]];

  var $ = function (id) { return document.getElementById(id); };
  var S = { key: null, data: null, mtime: 0, month: thisMonth(), kind: "out", saving: false,
            pending: false, tSave: null, connected: false, filterCat: "", q: "", catTouched: false,
            editing: null, undo: null };

  /* ------------------------------------------------------------ 小工具 */
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); }
  function thisMonth() { return ymd(new Date()).slice(0, 7); }
  function today() { return ymd(new Date()); }
  function shiftMonth(m, k) {
    var y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + k;
    var d = new Date(y, mo, 1);
    return d.getFullYear() + "-" + p2(d.getMonth() + 1);
  }
  function daysIn(m) { return new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate(); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function cur() { return (S.data && S.data.currency) || "¥"; }
  function fmt(c, sign) {
    var neg = c < 0, v = Math.abs(c);
    var yuan = Math.floor(v / 100), fen = v % 100;
    var s = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fen ? "." + p2(fen) : "");
    return (neg ? "−" : (sign && c > 0 ? "+" : "")) + cur() + s;
  }
  function m(c, sign) { return '<span class="m">' + esc(fmt(c, sign)) + "</span>"; }
  /* 「12+8.5」「3*15」这类也认；只放行数字和四则运算符 */
  function parseAmt(t) {
    t = String(t || "").replace(/[，,￥¥$\s]/g, "").replace(/[×xX]/g, "*").replace(/÷/g, "/");
    if (!t) return null;
    if (!/^[\d+\-*/().]+$/.test(t)) return NaN;
    var v;
    try { v = Function('"use strict";return (' + t + ")")(); } catch (e) { return NaN; }
    if (typeof v !== "number" || !isFinite(v)) return NaN;
    return Math.round(v * 100);
  }
  function plain(c) { return (c / 100).toFixed(2).replace(/\.00$/, ""); }

  function toast(text, kind, action, ms) {
    var el = $("bg-msg");
    el.className = "bg-toast" + (kind === "bad" ? " bad" : "");
    el.innerHTML = "<span></span>";
    el.firstChild.textContent = text;
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
  function setStatus(t, cls) {
    var s = $("bg-status");
    s.textContent = t;
    s.className = "passcount" + (cls ? " " + cls : "");
  }

  /* ------------------------------------------------------------ 服务调用 */
  function api(path, opt) {
    opt = opt || {};
    opt.headers = { "Content-Type": "application/json", "X-Lab-Key": S.key || "" };
    return fetch(BASE + path, opt).catch(function () {
      var e = new Error("连不上本机服务");
      e.status = 0;
      throw e;
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error(j.error || ("HTTP " + r.status));
          e.status = r.status;
          e.body = j;
          throw e;
        }
        return j;
      });
    });
  }

  function fresh() {
    return {
      version: 1, currency: "¥",
      categories: DEFAULT_CATS.map(function (c) { return { id: c[0], name: c[1], roll: !!c[2], hidden: false }; }),
      months: {}, tx: [], recurring: []
    };
  }
  function normalize(d) {
    d = d && typeof d === "object" ? d : fresh();
    d.version = 1;
    d.currency = typeof d.currency === "string" && d.currency ? d.currency : "¥";
    d.categories = Array.isArray(d.categories) ? d.categories : [];
    d.months = d.months && typeof d.months === "object" ? d.months : {};
    d.tx = Array.isArray(d.tx) ? d.tx : [];
    d.recurring = Array.isArray(d.recurring) ? d.recurring : [];
    return d;
  }

  function connect(key) {
    S.key = key;
    setStatus("连接中…");
    return api("/api/budget").then(function (j) {
      S.connected = true;
      S.data = normalize(j.data);
      S.mtime = j.mtime || 0;
      $("bg-lock").hidden = true;
      $("bg-shell").hidden = false;
      setStatus(j.data ? "已连上 · 本机" : "已连上 · 新账本", "ok");
      if (!j.data) save(true);
      setAddDate();
      render();
      if (window.LabSync) {
        LabSync.attach("budget", { get: function () { return S.data; }, normalize: normalize,
                                   set: function (d) { S.data = normalize(d); changed(); } });
        if (!S.syncBadge) { S.syncBadge = true; LabSync.badge(["budget"]); }
      }
    });
  }
  function showLock(why) {
    S.connected = false;
    $("bg-lock").hidden = false;
    $("bg-shell").hidden = true;
    $("bg-lockmsg").textContent = why || "";
    setStatus("未连接", "bad");
  }
  function failConnect(e, saved) {
    if (e.status === 401) {
      try { localStorage.removeItem(KEYNAME); } catch (_) {}
      showLock(saved ? "存的口令已经不作数了，重新输一次。" : "口令不对。");
      return;
    }
    showLock("本机服务没开。" + START_HINT + "开了以后这里会自动连上。");
    if (saved) setTimeout(function () { connect(saved).catch(function (e2) { failConnect(e2, saved); }); }, 4000);
  }
  function askKey() {
    askText("连接本机服务", "输入 sitekeeper 启动时打印的口令（只存这台电脑）",
            { ok: "连接", password: true }).then(function (r) {
      if (!r.ok) return;
      try { localStorage.setItem(KEYNAME, r.value); } catch (e) {}
      connect(r.value).catch(function (e) { failConnect(e, ""); });
    });
  }

  /* 改一下就排一次存；连着改只存最后一次 */
  function changed() {
    S.pending = true;
    setStatus("有改动 · 待存", "");
    clearTimeout(S.tSave);
    S.tSave = setTimeout(function () { save(); }, 500);
    render();
  }
  function save(quiet) {
    if (S.saving) { S.pending = true; return; }
    S.saving = true;
    S.pending = false;
    if (!quiet) setStatus("保存中…");
    return api("/api/budget", { method: "POST", body: JSON.stringify({ data: S.data, base: S.mtime || null }) })
      .then(function (j) {
        S.mtime = j.mtime;
        if (window.LabSync) LabSync.kick("budget");
        var d = new Date();
        setStatus("已存 " + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()), "ok");
      })
      .catch(function (e) {
        if (e.status === 409) {
          S.data = normalize(e.body.data);
          S.mtime = e.body.mtime;
          render();
          toast("别的标签页刚存过账本，已换成那一版。你刚才那一步没存上，再做一次。", "bad", null, 6000);
          setStatus("已载入最新版", "");
          return;
        }
        S.pending = true;
        setStatus(e.status === 0 ? "服务断了 · 改动还在页面里" : "没存上：" + e.message, "bad");
        if (e.status === 401) { showLock("口令失效了。"); return; }
        clearTimeout(S.tSave);
        S.tSave = setTimeout(function () { save(); }, 4000);
      })
      .then(function () {
        S.saving = false;
        if (S.pending && S.connected) { clearTimeout(S.tSave); S.tSave = setTimeout(function () { save(); }, 300); }
      });
  }

  /* ------------------------------------------------------------ 计算 */
  function catById(id) {
    for (var i = 0; i < S.data.categories.length; i++) if (S.data.categories[i].id === id) return S.data.categories[i];
    return null;
  }
  function catName(id) { var c = catById(id); return c ? c.name : "未分类"; }
  function monthTx(mo) { return S.data.tx.filter(function (t) { return t.d && t.d.slice(0, 7) === mo; }); }
  function allocOf(mo) { var x = S.data.months[mo]; return (x && x.alloc) || {}; }
  function firstMonth() {
    var f = S.month;
    Object.keys(S.data.months).forEach(function (k) { if (k < f) f = k; });
    S.data.tx.forEach(function (t) { var k = t.d.slice(0, 7); if (k < f) f = k; });
    return f;
  }
  function spentBy(mo) {
    var r = {}, inc = 0, out = 0;
    monthTx(mo).forEach(function (t) {
      if (t.kind === "in") { inc += t.amt; return; }
      out += t.amt;
      r[t.cat || ""] = (r[t.cat || ""] || 0) + t.amt;
    });
    return { cat: r, income: inc, out: out };
  }
  /* 开了「滚入下月」的分类：上月剩下（或超支）的带到这个月 */
  function carryTo(mo) {
    var carry = {}, k = firstMonth();
    var rolls = S.data.categories.filter(function (c) { return c.roll; });
    while (k < mo) {
      var a = allocOf(k), sp = spentBy(k).cat;
      rolls.forEach(function (c) {
        carry[c.id] = (carry[c.id] || 0) + (a[c.id] || 0) - (sp[c.id] || 0);
      });
      k = shiftMonth(k, 1);
    }
    return carry;
  }
  function calc(mo) {
    var a = allocOf(mo), sp = spentBy(mo), carry = carryTo(mo);
    var rows = [], allocSum = 0, availSum = 0;
    S.data.categories.forEach(function (c) {
      var al = a[c.id] || 0, ca = c.roll ? (carry[c.id] || 0) : 0, s = sp.cat[c.id] || 0;
      if (c.hidden && !al && !s && !ca) return;
      allocSum += al;
      availSum += al + ca;
      rows.push({ c: c, alloc: al, carry: ca, spent: s, left: al + ca - s });
    });
    if (sp.cat[""]) rows.push({ c: { id: "", name: "未分类" }, alloc: 0, carry: 0, spent: sp.cat[""], left: -sp.cat[""], loose: true });
    return { rows: rows, allocSum: allocSum, availSum: availSum, income: sp.income, out: sp.out };
  }
  function elapsed(mo) {
    var t = thisMonth();
    if (mo < t) return 1;
    if (mo > t) return 0;
    return new Date().getDate() / daysIn(mo);
  }

  /* ------------------------------------------------------------ 渲染 */
  function render() {
    if (!S.data) return;
    $("bg-mon").textContent = S.month;
    $("bg-mon").classList.toggle("pri", S.month === thisMonth());
    $("s-cur").value = S.data.currency;
    var k = calc(S.month);
    renderTiles(k);
    renderAlloc(k);
    renderTx();
    renderTrend();
    renderCats();
    renderRec();
    renderCatSelects();
    renderNotes();
  }

  function tile(kname, v, sub, cls) {
    return '<div class="bg-tile ' + (cls || "") + '"><div class="k">' + esc(kname) + '</div><div class="v">' + v +
      '</div><div class="s">' + (sub || "&nbsp;") + "</div></div>";
  }
  function renderTiles(k) {
    var unalloc = k.income - k.allocSum;
    var left = k.availSum - k.out;
    var h = "";
    h += tile("收入", m(k.income), monthTx(S.month).filter(function (t) { return t.kind === "in"; }).length + " 笔");
    h += tile("已分配", m(k.allocSum), k.income ? Math.round(k.allocSum / k.income * 100) + "% 的收入" : "还没记收入");
    h += tile("待分配", m(unalloc), unalloc < 0 ? "分出去的比挣的多" : (unalloc ? "还没安排的钱" : "每一块都有去处"),
              unalloc < 0 ? "bad" : (unalloc === 0 && k.income ? "ok" : ""));
    h += tile("已花", m(k.out), k.availSum ? Math.round(k.out / k.availSum * 100) + "% 的预算" : "&nbsp;");
    h += tile("预算剩余", m(left), "含结转", left < 0 ? "bad" : "key");
    var mo = S.month;
    if (mo === thisMonth()) {
      var dleft = daysIn(mo) - new Date().getDate() + 1;
      h += tile("每天还能花", m(Math.max(0, Math.floor(left / dleft))), "剩 " + dleft + " 天（含今天）", left < 0 ? "bad" : "");
    } else {
      h += tile("本月结余", m(k.income - k.out), "收入 − 支出", k.income - k.out < 0 ? "bad" : "ok");
    }
    $("bg-tiles").innerHTML = h;

    var f = elapsed(mo), pace = $("bg-pace");
    if (!k.availSum || f === 0) { pace.innerHTML = f === 0 ? "这个月还没到，可以先把分配排好。" : "先在下面给各分类填分配额。"; return; }
    var used = k.out / k.availSum;
    var diff = Math.round((used - f) * 100);
    pace.innerHTML = f < 1
      ? "时间过了 <b>" + Math.round(f * 100) + "%</b>，钱花了 <b>" + Math.round(used * 100) + "%</b>，" +
        (diff > 3 ? '<span class="bad">比进度快 ' + diff + " 个百分点</span>" :
         diff < -3 ? '<span class="ok">比进度慢 ' + (-diff) + " 个百分点</span>" : "和进度差不多") + "。条上的虚线是今天该到的位置。"
      : "这个月已结束：预算用掉 <b>" + Math.round(used * 100) + "%</b>" +
        (used > 1 ? '，<span class="bad">超支 ' + esc(fmt(k.out - k.availSum)) + "</span>" : "") + "。";
  }

  function renderAlloc(k) {
    var f = elapsed(S.month), h = "";
    k.rows.forEach(function (r) {
      var avail = r.alloc + r.carry, pct = avail > 0 ? Math.min(1, r.spent / avail) : (r.spent ? 1 : 0);
      var cls = r.spent > avail ? "over" : (avail > 0 && r.spent / avail > Math.max(f, .85) ? "warn" : "");
      h += '<tr class="click' + (S.filterCat === r.c.id && S.filterCat !== null && S.filterFromRow ? " sel" : "") + '" data-cat="' + esc(r.c.id) + '">' +
        '<td class="nm">' + esc(r.c.name) + (r.c.roll ? "<small>滚</small>" : "") + "</td>" +
        '<td class="n">' + (r.loose ? '<span class="dim">—</span>' :
          '<input class="al m" data-cat="' + esc(r.c.id) + '" value="' + (r.alloc ? plain(r.alloc) : "") + '" placeholder="0" inputmode="decimal">') + "</td>" +
        '<td class="n ' + (r.carry < 0 ? "bad" : "dim") + '">' + (r.carry ? m(r.carry, true) : "") + "</td>" +
        '<td class="n">' + (r.spent ? m(r.spent) : '<span class="dim">0</span>') + "</td>" +
        '<td class="n ' + (r.left < 0 ? "bad" : "") + '">' + m(r.left) + "</td>" +
        '<td class="bar"><div class="bg-bar' + (avail > 0 || r.spent ? "" : " none") + '"><i class="' + cls + '" style="width:' + (pct * 100).toFixed(1) + '%"></i>' +
        (f > 0 && f < 1 && avail > 0 ? '<b style="left:' + (f * 100).toFixed(1) + '%"></b>' : "") + "</div></td></tr>";
    });
    $("bg-alloc").tBodies[0].innerHTML = h || '<tr><td colspan="6" class="dim">没有分类，在左边加一个。</td></tr>';
    var tl = k.availSum - k.out;
    $("bg-alloc").tFoot.innerHTML = '<tr><td>合计</td><td class="n">' + m(k.allocSum) + '</td><td class="n dim">' +
      (k.availSum - k.allocSum ? m(k.availSum - k.allocSum, true) : "") + '</td><td class="n">' + m(k.out) +
      '</td><td class="n ' + (tl < 0 ? "bad" : "") + '">' + m(tl) + "</td><td></td></tr>";
  }

  function txMatches(t) {
    if (S.filterCat !== "" && (t.kind === "in" || (t.cat || "") !== S.filterCat)) return false;
    if (!S.q) return true;
    var q = S.q.toLowerCase();
    return (t.note || "").toLowerCase().indexOf(q) >= 0 ||
      (t.kind === "in" ? "收入" : catName(t.cat)).toLowerCase().indexOf(q) >= 0 ||
      plain(t.amt).indexOf(q) >= 0 || t.d.indexOf(q) >= 0;
  }
  function renderTx() {
    var list = monthTx(S.month).filter(txMatches).sort(function (a, b) {
      return a.d < b.d ? 1 : a.d > b.d ? -1 : (b.ts || 0) - (a.ts || 0);
    });
    var box = $("bg-txs");
    if (!list.length) {
      box.innerHTML = '<div class="bg-empty">' + (S.q || S.filterCat !== "" ? "没有对得上的流水。" : "这个月还没记账。左边金额框里敲个数字，回车就记上了。") + "</div>";
      return;
    }
    var h = "", day = null, WD = "日一二三四五六";
    var sums = {};
    list.forEach(function (t) { if (t.kind !== "in") sums[t.d] = (sums[t.d] || 0) + t.amt; });
    list.forEach(function (t) {
      if (t.d !== day) {
        day = t.d;
        var dd = new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
        h += '<div class="bg-day"><span>' + day.slice(5) + " 周" + WD[dd.getDay()] + (day === today() ? " · 今天" : "") +
          "</span><span>" + (sums[day] ? "支出 " + m(sums[day]) : "") + "</span></div>";
      }
      if (S.editing === t.id) { h += editRow(t); return; }
      h += '<div class="bg-tx" data-id="' + esc(t.id) + '">' +
        '<span class="c">' + esc(t.kind === "in" ? "收入" : catName(t.cat)) + "</span>" +
        '<span class="t" title="点一下改">' + (esc(t.note) || '<span style="color:var(--dim)">（无备注）</span>') +
        (t.rec ? '<span class="rec">固定</span>' : "") + "</span>" +
        '<span class="a' + (t.kind === "in" ? " in" : "") + '" title="点一下改">' + m(t.kind === "in" ? t.amt : -t.amt, true) + "</span>" +
        '<button type="button" class="x" title="删掉">×</button></div>';
    });
    box.innerHTML = h;
    var ed = box.querySelector(".bg-tx.editing input[data-f=amt]");
    if (ed && !ed.dataset.focused) { ed.dataset.focused = "1"; ed.focus(); ed.select(); }
  }
  function catOptions(sel, withNone) {
    var h = withNone ? '<option value="">未分类</option>' : "";
    S.data.categories.forEach(function (c) {
      if (c.hidden && c.id !== sel) return;
      h += '<option value="' + esc(c.id) + '"' + (c.id === sel ? " selected" : "") + ">" + esc(c.name) + "</option>";
    });
    return h;
  }
  function editRow(t) {
    return '<div class="bg-tx editing" data-id="' + esc(t.id) + '">' +
      '<input data-f="d" value="' + esc(t.d) + '" title="日期">' +
      '<span style="display:flex;gap:4px;min-width:0">' +
      (t.kind === "in" ? "" : '<select data-f="cat" style="width:7em">' + catOptions(t.cat, true) + "</select>") +
      '<input data-f="note" value="' + esc(t.note) + '" placeholder="备注"></span>' +
      '<input data-f="amt" value="' + plain(t.amt) + '" style="width:6em;text-align:right" inputmode="decimal">' +
      '<button type="button" class="x" style="visibility:visible" title="保存（Enter），Esc 取消" data-save="1">✓</button></div>';
  }

  function renderTrend() {
    var months = [], i;
    for (i = 5; i >= 0; i--) months.push(shiftMonth(S.month, -i));
    var vals = months.map(function (mo) { var s = spentBy(mo); return { mo: mo, inc: s.income, out: s.out }; });
    var max = 1;
    vals.forEach(function (v) { max = Math.max(max, v.inc, v.out); });
    var W = 600, H = 190, top = 18, bot = 26, ch = H - top - bot, bw = W / 6;
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="近六个月收支">';
    vals.forEach(function (v, j) {
      var x = j * bw, oh = v.out / max * ch, ih = v.inc / max * ch;
      svg += '<rect class="rout' + (v.mo === S.month ? "" : "") + '" x="' + (x + bw * .3) + '" y="' + (top + ch - oh) + '" width="' + (bw * .4) + '" height="' + oh + '"></rect>';
      if (v.inc) svg += '<rect class="rin" x="' + (x + bw * .22) + '" y="' + (top + ch - ih) + '" width="' + (bw * .56) + '" height="' + ih + '"></rect>';
      if (v.out) svg += '<text class="v m" x="' + (x + bw / 2) + '" y="' + Math.max(11, top + ch - Math.max(oh, ih) - 5) + '" text-anchor="middle">' + esc(fmt(v.out)) + "</text>";
      svg += '<text x="' + (x + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle"' + (v.mo === S.month ? ' style="fill:var(--fg);font-weight:700"' : "") + ">" + v.mo.slice(2).replace("-", ".") + "</text>";
    });
    svg += '<line class="ax" x1="0" x2="' + W + '" y1="' + (top + ch) + '" y2="' + (top + ch) + '"></line></svg>';
    $("bg-trend").innerHTML = svg;
  }

  function renderCats() {
    var cats = S.data.categories, h = "";
    cats.forEach(function (c, i) {
      h += '<div class="bg-crow' + (c.hidden ? " hid" : "") + '" data-id="' + esc(c.id) + '">' +
        '<input data-f="name" value="' + esc(c.name) + '" maxlength="20">' +
        '<button type="button" data-a="up" title="上移"' + (i ? "" : " disabled") + ">↑</button>" +
        '<button type="button" data-a="down" title="下移"' + (i < cats.length - 1 ? "" : " disabled") + ">↓</button>" +
        '<button type="button" data-a="roll" class="' + (c.roll ? "on" : "") + '" title="结余滚入下月：这个月没花完（或超支）的带到下个月">滚</button>' +
        '<button type="button" data-a="del" title="' + (c.hidden ? "重新显示" : "删除（有流水的话改成隐藏）") + '">' + (c.hidden ? "显" : "×") + "</button></div>";
    });
    $("bg-cats").innerHTML = h;
    $("bg-catcount").textContent = cats.filter(function (c) { return !c.hidden; }).length + " 个";
  }

  function recDone(r, mo) { return S.data.tx.some(function (t) { return t.rec === r.id && t.d.slice(0, 7) === mo; }); }
  function renderRec() {
    var h = "";
    S.data.recurring.forEach(function (r) {
      var done = recDone(r, S.month);
      h += '<div class="bg-rrow" data-id="' + esc(r.id) + '"><span class="nm">' + esc(r.name) +
        ' <span class="dim">每月 ' + r.day + " 号 · " + esc(r.kind === "in" ? "收入" : catName(r.cat)) + "</span></span>" +
        '<span class="' + (done ? "done" : "") + '">' + (done ? "✓ " : "") + m(r.kind === "in" ? r.amt : -r.amt, true) + "</span>" +
        '<button type="button" data-a="del" title="删掉这一项（已记的流水不动）">×</button></div>';
    });
    if (S.recForm) {
      h += '<div class="bg-rrow" style="grid-template-columns:1fr;gap:4px" id="bg-recform">' +
        '<input data-f="name" placeholder="名称，比如 房租" maxlength="30">' +
        '<div style="display:flex;gap:4px"><input data-f="amt" placeholder="金额" inputmode="decimal" style="flex:1">' +
        '<input data-f="day" placeholder="几号" value="1" style="width:4em"></div>' +
        '<div style="display:flex;gap:4px"><select data-f="kind" style="width:5em"><option value="out">支出</option><option value="in">收入</option></select>' +
        '<select data-f="cat" style="flex:1">' + catOptions("", true) + "</select></div>" +
        '<div style="display:flex;gap:4px;justify-content:flex-end"><button type="button" data-a="cancel">取消</button><button type="button" data-a="ok" class="pri">加上</button></div></div>';
    }
    $("bg-rec").innerHTML = h;
    var pend = S.data.recurring.filter(function (r) { return !recDone(r, S.month); }).length;
    $("bg-reccount").textContent = S.data.recurring.length + " 项" + (pend ? " · " + pend + " 未记" : "");
    $("bg-recapply").disabled = !pend;
  }

  function renderCatSelects() {
    var a = $("a-cat"), keep = a.value;
    a.innerHTML = catOptions(keep, true);
    if (keep && catById(keep)) a.value = keep;
    else if (!keep && !S.catTouched) { var first = S.data.categories.filter(function (c) { return !c.hidden; })[0]; if (first) a.value = first.id; }
    a.disabled = S.kind === "in";
    var fc = $("bg-fcat"), fv = S.filterCat;
    fc.innerHTML = '<option value="">全部分类</option>' + S.data.categories.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>";
    }).join("");
    fc.value = fv;
  }

  /* 备注联想：按出现次数排；选中一条熟悉的备注时顺手把分类也带上 */
  var noteCat = {};
  function renderNotes() {
    var cnt = {};
    noteCat = {};
    S.data.tx.slice(-800).forEach(function (t) {
      if (!t.note) return;
      cnt[t.note] = (cnt[t.note] || 0) + 1;
      if (t.kind !== "in") noteCat[t.note] = t.cat;
    });
    $("bg-notes").innerHTML = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).slice(0, 40)
      .map(function (n) { return '<option value="' + esc(n) + '">'; }).join("");
  }

  /* ------------------------------------------------------------ 动作 */
  function setAddDate() {
    var d = $("a-date"), v = d.value;
    if (v && v.slice(0, 7) === S.month) return;
    d.value = S.month === thisMonth() ? today() : S.month + "-01";
  }
  function goMonth(mo) {
    S.month = mo;
    S.editing = null;
    setAddDate();
    render();
  }
  function addTx(e) {
    if (e) e.preventDefault();
    var amt = parseAmt($("a-amt").value);
    if (amt === null) { $("a-amt").focus(); toast("先填金额", "bad"); return; }
    if (isNaN(amt) || amt <= 0) { $("a-amt").classList.add("bad"); toast("金额看不懂，写数字或者 12+8.5 这样的式子", "bad"); return; }
    var d = $("a-date").value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d))) { $("a-date").classList.add("bad"); toast("日期写成 2026-11-14 这样", "bad"); return; }
    var t = { id: uid(), d: d, amt: amt, kind: S.kind, cat: S.kind === "in" ? "" : $("a-cat").value, note: $("a-note").value.trim(), ts: Date.now() };
    S.data.tx.push(t);
    $("a-amt").value = "";
    $("a-note").value = "";
    $("a-amt").classList.remove("bad");
    $("a-date").classList.remove("bad");
    S.catTouched = false;
    if (d.slice(0, 7) !== S.month) { S.month = d.slice(0, 7); }
    changed();
    toast("记上了：" + (t.kind === "in" ? "收入" : catName(t.cat)) + " " + fmt(t.amt), "", {
      label: "撤销", run: function () { removeTx(t.id, true); }
    });
    $("a-amt").focus();
  }
  function removeTx(id, silent) {
    var i = S.data.tx.findIndex(function (t) { return t.id === id; });
    if (i < 0) return;
    var t = S.data.tx.splice(i, 1)[0];
    changed();
    if (!silent) toast("删了一笔 " + fmt(t.amt), "", { label: "撤销", run: function () { S.data.tx.push(t); changed(); } }, 5000);
  }
  function commitEdit(row) {
    var t = S.data.tx.find(function (x) { return x.id === row.dataset.id; });
    if (!t) return;
    var get = function (f) { var el = row.querySelector("[data-f=" + f + "]"); return el ? el.value : null; };
    var amt = parseAmt(get("amt")), d = (get("d") || "").trim();
    if (!amt || isNaN(amt) || amt <= 0) { toast("金额看不懂", "bad"); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d))) { toast("日期写成 2026-11-14 这样", "bad"); return; }
    t.amt = amt; t.d = d; t.note = (get("note") || "").trim();
    if (get("cat") !== null) t.cat = get("cat");
    S.editing = null;
    changed();
  }
  function setAlloc(cat, raw) {
    var v = parseAmt(raw);
    if (v === null) v = 0;
    if (isNaN(v) || v < 0) { toast("分配额看不懂", "bad"); render(); return; }
    var mo = S.data.months[S.month] = S.data.months[S.month] || {};
    mo.alloc = mo.alloc || {};
    if (v) mo.alloc[cat] = v; else delete mo.alloc[cat];
    changed();
  }
  function copyLast() {
    var prev = allocOf(shiftMonth(S.month, -1));
    if (!Object.keys(prev).length) { toast("上个月没有分配可以抄", "bad"); return; }
    var go = function () {
      var mo = S.data.months[S.month] = S.data.months[S.month] || {};
      mo.alloc = JSON.parse(JSON.stringify(prev));
      changed();
      toast("照上月填好了", "");
    };
    if (Object.keys(allocOf(S.month)).length) ask("这个月已经填过分配，用上个月的覆盖掉？").then(function (y) { if (y) go(); });
    else go();
  }
  /* 待分配的钱按上个月各分类实际花费的比例摊，取整到元；零头给花得最多的那类 */
  function fillByLast() {
    var k = calc(S.month), left = k.income - k.allocSum;
    if (left <= 0) { toast(k.income ? "没有待分配的钱" : "先记这个月的收入", "bad"); return; }
    var sp = spentBy(shiftMonth(S.month, -1)).cat, ids = [];
    S.data.categories.forEach(function (c) { if (!c.hidden && sp[c.id] > 0) ids.push(c.id); });
    if (!ids.length) { toast("上个月没有分类花费可以参照", "bad"); return; }
    var total = ids.reduce(function (s, id) { return s + sp[id]; }, 0), given = 0;
    var mo = S.data.months[S.month] = S.data.months[S.month] || {};
    mo.alloc = mo.alloc || {};
    ids.sort(function (a, b) { return sp[b] - sp[a]; });
    ids.forEach(function (id) {
      var part = Math.floor(left * sp[id] / total / 100) * 100;
      mo.alloc[id] = (mo.alloc[id] || 0) + part;
      given += part;
    });
    mo.alloc[ids[0]] += left - given;
    changed();
    toast("把 " + fmt(left) + " 按上月花费比例摊开了", "");
  }
  function applyRec() {
    var n = 0, dim = daysIn(S.month);
    S.data.recurring.forEach(function (r) {
      if (recDone(r, S.month)) return;
      S.data.tx.push({ id: uid(), d: S.month + "-" + p2(Math.min(r.day, dim)), amt: r.amt, kind: r.kind, cat: r.kind === "in" ? "" : r.cat,
                       note: r.name, rec: r.id, ts: Date.now() });
      n++;
    });
    if (n) { changed(); toast("记入了 " + n + " 项固定收支", ""); }
  }

  /* ------------------------------------------------------------ 导入导出 */
  function csvCell(v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function download(name, text, type) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportCsv(all) {
    var rows = (all ? S.data.tx.slice() : monthTx(S.month)).sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    var out = ["日期,类型,分类,金额,备注"];
    rows.forEach(function (t) {
      out.push([t.d, t.kind === "in" ? "收入" : "支出", t.kind === "in" ? "" : catName(t.cat), plain(t.amt), t.note].map(csvCell).join(","));
    });
    download("budget-" + (all ? "all" : S.month) + ".csv", "\ufeff" + out.join("\r\n") + "\r\n", "text/csv;charset=utf-8");
  }
  function parseCsv(text) {
    var rows = [], row = [], cell = "", q = false, i, ch;
    text = text.replace(/^\ufeff/, "");
    for (i = 0; i < text.length; i++) {
      ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim(); }); });
  }
  /* 支付宝 / 微信导出的账单走 bills.js：按单号去重，没单号的和已记的同日同金额对上；认不出来再按本页自己的 csv 格式读 */
  function importCsv(file) {
    if (!window.Bills) return importPlain(file);
    Bills.readFile(file).then(function (r) {
      /* 先和远端对一次，免得手机上刚截图记的那几笔还没到，被当成新的再导一遍 */
      return (window.LabSync && LabSync.isReady() ? LabSync.syncNow("budget").catch(function () {}) : Promise.resolve()).then(function () { return r; });
    }).then(function (r) {
      if (!r.rows) { if (/\.xlsx$/i.test(file.name)) toast("认不出这份 xlsx，导出成 csv 再试", "bad", null, 4000); else importPlain(file); return; }
      var rec = Bills.reconcile(r.rows, S.data.tx), lrn = Bills.learn(S.data.tx);
      if (!rec.add.length && !rec.match.length) { toast("这份" + r.src + "账单里的都已经记过了", "", null, 4000); return; }
      ask("导入" + r.src + "账单：新增 " + rec.add.length + " 笔，和已记的对上 " + rec.match.length + " 笔，重复跳过 " + rec.dup + " 笔" +
          (r.skipped ? "；不计收支 / 已关闭 / 全额退款的 " + r.skipped + " 笔不算" : "") + "。新增的按商家猜分类。").then(function (y) {
        if (!y) return;
        rec.match.forEach(function (p) { if (p.row.ref) p.tx.ref = p.row.ref; if (!p.tx.src) p.tx.src = p.row.src; });
        rec.add.forEach(function (row) {
          var note = row.merchant || row.goods || row.type;
          S.data.tx.push({ id: uid(), d: row.d, amt: row.amt, kind: row.kind,
                           cat: row.kind === "in" ? "" : Bills.guessCat([row.merchant, row.goods, row.type].join(" "), S.data.categories, lrn),
                           note: note.slice(0, 60), src: row.src, ref: row.ref, ts: Date.now() });
        });
        changed();
        toast("导入了 " + rec.add.length + " 笔，对上 " + rec.match.length + " 笔", "", null, 4000);
      });
    }).catch(function (e) { toast(e.message || "读不了这个文件", "bad", null, 4000); });
  }
  function importPlain(file) {
    var rd = new FileReader();
    rd.onload = function () {
      var rows = parseCsv(String(rd.result));
      if (rows.length && /日期|date/i.test(rows[0][0])) rows.shift();
      var seen = {}, add = [], bad = 0, newCats = 0;
      S.data.tx.forEach(function (t) { seen[[t.d, t.kind, t.amt, t.note].join("|")] = 1; });
      rows.forEach(function (r) {
        var d = (r[0] || "").trim().replace(/\//g, "-").replace(/-(\d)(?!\d)/g, "-0$1");
        var kind = /收入|in/i.test(r[1] || "") ? "in" : "out";
        var amt = parseAmt(r[3]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !amt || isNaN(amt)) { bad++; return; }
        if (amt < 0) { amt = -amt; }
        var note = (r[4] || "").trim(), key = [d, kind, amt, note].join("|");
        if (seen[key]) return;
        seen[key] = 1;
        var cat = "";
        var cname = (r[2] || "").trim();
        if (kind === "out" && cname && cname !== "未分类") {
          var c = S.data.categories.find(function (x) { return x.name === cname; });
          if (!c) { c = { id: "c" + uid(), name: cname.slice(0, 20), roll: false, hidden: false }; S.data.categories.push(c); newCats++; }
          cat = c.id;
        }
        add.push({ id: uid(), d: d, amt: amt, kind: kind, cat: cat, note: note, ts: Date.now() });
      });
      if (!add.length) { toast("没有可导入的新行" + (bad ? "（" + bad + " 行看不懂）" : ""), "bad", null, 4000); if (newCats) changed(); return; }
      ask("导入 " + add.length + " 笔流水" + (newCats ? "，新建 " + newCats + " 个分类" : "") + (bad ? "；另有 " + bad + " 行看不懂会跳过" : "") +
          "。和已有流水日期、金额、备注都一样的已经去掉了。").then(function (y) {
        if (!y) return;
        S.data.tx = S.data.tx.concat(add);
        changed();
        toast("导入了 " + add.length + " 笔", "");
      });
    };
    rd.readAsText(file, "utf-8");
  }

  /* ------------------------------------------------------------ 事件 */
  function typing(e) {
    var t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  }
  function bind() {
    $("bg-retry").addEventListener("click", askKey);
    $("bg-prev").addEventListener("click", function () { goMonth(shiftMonth(S.month, -1)); });
    $("bg-next").addEventListener("click", function () { goMonth(shiftMonth(S.month, 1)); });
    $("bg-mon").addEventListener("click", function () { goMonth(thisMonth()); });
    $("bg-add").addEventListener("submit", addTx);
    $("bg-kind").addEventListener("click", function (e) {
      var b = e.target.closest(".chip");
      if (!b) return;
      S.kind = b.dataset.kind;
      [].forEach.call(this.children, function (x) { x.classList.toggle("on", x === b); });
      $("bg-kindlbl").textContent = S.kind === "in" ? "收入" : "支出";
      $("bg-kindlbl").className = S.kind === "in" ? "in" : "";
      $("a-cat").disabled = S.kind === "in";
      $("a-amt").focus();
    });
    $("a-cat").addEventListener("change", function () { S.catTouched = true; });
    $("a-note").addEventListener("input", function () {
      var c = noteCat[this.value];
      if (c !== undefined && !S.catTouched && S.kind === "out" && (c === "" || catById(c))) $("a-cat").value = c;
    });
    ["a-amt", "a-date"].forEach(function (id) { $(id).addEventListener("input", function () { this.classList.remove("bad"); }); });
    $("a-datebtn").addEventListener("click", function () {
      var v = new Date($("a-date").value + "T00:00");
      datePicker(this, { value: isNaN(v) ? new Date() : v, onPick: function (d) { $("a-date").value = ymd(d); } });
    });
    $("s-cur").addEventListener("change", function () {
      S.data.currency = this.value.trim().slice(0, 4) || "¥";
      changed();
    });

    /* 分配额 */
    var tb = $("bg-alloc");
    tb.addEventListener("change", function (e) {
      if (e.target.classList.contains("al")) setAlloc(e.target.dataset.cat, e.target.value);
    });
    tb.addEventListener("keydown", function (e) {
      if (!e.target.classList.contains("al")) return;
      if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var all = [].slice.call(tb.querySelectorAll("input.al")), i = all.indexOf(e.target);
        var next = all[i + (e.key === "ArrowUp" ? -1 : 1)];
        var nid = next && next.dataset.cat;
        e.target.blur();               /* 先触发 change，重绘之后再把焦点放回下一格 */
        if (nid !== undefined) {
          var n2 = tb.querySelector('input.al[data-cat="' + nid + '"]');
          if (n2) { n2.focus(); n2.select(); }
        }
      }
    });
    tb.addEventListener("click", function (e) {
      if (e.target.closest("input")) return;
      var tr = e.target.closest("tr[data-cat]");
      if (!tr) return;
      var id = tr.dataset.cat;
      S.filterCat = S.filterCat === id && S.filterFromRow ? "" : id;
      S.filterFromRow = S.filterCat !== "";
      render();
      if (S.filterCat !== "") $("bg-txs").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    tb.addEventListener("focusin", function (e) { if (e.target.classList.contains("al")) e.target.select(); });

    $("bg-copy").addEventListener("click", copyLast);
    $("bg-fill").addEventListener("click", fillByLast);
    $("bg-q").addEventListener("input", function () { S.q = this.value.trim(); renderTx(); });
    $("bg-q").addEventListener("keydown", function (e) { if (e.key === "Escape") { this.value = ""; S.q = ""; renderTx(); this.blur(); } });
    $("bg-fcat").addEventListener("change", function () { S.filterCat = this.value; S.filterFromRow = false; render(); });

    /* 流水：点备注或金额就地改，× 删（可撤销） */
    var tx = $("bg-txs");
    tx.addEventListener("click", function (e) {
      var row = e.target.closest(".bg-tx");
      if (!row) return;
      if (row.classList.contains("editing")) { if (e.target.closest("[data-save]")) commitEdit(row); return; }
      if (e.target.closest(".x")) { removeTx(row.dataset.id); return; }
      if (e.target.closest(".t,.a,.c")) { S.editing = row.dataset.id; renderTx(); }
    });
    tx.addEventListener("keydown", function (e) {
      var row = e.target.closest(".bg-tx.editing");
      if (!row) return;
      if (e.key === "Enter") { e.preventDefault(); commitEdit(row); }
      else if (e.key === "Escape") { S.editing = null; renderTx(); }
    });

    /* 分类 */
    var cats = $("bg-cats");
    cats.addEventListener("change", function (e) {
      var row = e.target.closest(".bg-crow"), c = row && catById(row.dataset.id);
      if (!c || e.target.dataset.f !== "name") return;
      var v = e.target.value.trim();
      if (!v) { e.target.value = c.name; return; }
      c.name = v.slice(0, 20);
      changed();
    });
    cats.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-a]"), row = e.target.closest(".bg-crow");
      if (!b || !row) return;
      var list = S.data.categories, i = list.findIndex(function (c) { return c.id === row.dataset.id; }), c = list[i];
      if (b.dataset.a === "up" && i > 0) { list.splice(i - 1, 0, list.splice(i, 1)[0]); changed(); }
      else if (b.dataset.a === "down" && i < list.length - 1) { list.splice(i + 1, 0, list.splice(i, 1)[0]); changed(); }
      else if (b.dataset.a === "roll") { c.roll = !c.roll; changed(); toast(c.name + (c.roll ? "：结余会滚入下月" : "：每月从零开始"), ""); }
      else if (b.dataset.a === "del") {
        if (c.hidden) { c.hidden = false; changed(); return; }
        var used = S.data.tx.filter(function (t) { return t.cat === c.id; }).length;
        if (used) {
          ask("「" + c.name + "」下面有 " + used + " 笔流水，删了账就对不上。改成隐藏？（旧账照常统计，记账时不再出现）").then(function (y) {
            if (y) { c.hidden = true; changed(); }
          });
        } else {
          ask("删掉分类「" + c.name + "」？各月给它的分配额也一起去掉。").then(function (y) {
            if (!y) return;
            list.splice(list.indexOf(c), 1);
            Object.keys(S.data.months).forEach(function (k) { var a = S.data.months[k].alloc; if (a) delete a[c.id]; });
            changed();
          });
        }
      }
    });
    $("bg-catadd").addEventListener("click", function () {
      askText("新分类", "叫什么？", { ok: "加上" }).then(function (r) {
        var v = r.ok && r.value.trim();
        if (!v) return;
        if (S.data.categories.some(function (c) { return c.name === v; })) { toast("已经有这个分类了", "bad"); return; }
        S.data.categories.push({ id: "c" + uid(), name: v.slice(0, 20), roll: false, hidden: false });
        changed();
      });
    });

    /* 固定收支 */
    $("bg-recadd").addEventListener("click", function () {
      S.recForm = true;
      renderRec();
      var n = document.querySelector("#bg-recform [data-f=name]");
      if (n) n.focus();
    });
    $("bg-recapply").addEventListener("click", applyRec);
    $("bg-rec").addEventListener("change", function (e) {
      if (e.target.dataset.f === "kind") e.target.parentNode.querySelector("[data-f=cat]").disabled = e.target.value === "in";
    });
    $("bg-rec").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-a]");
      if (!b) return;
      if (b.dataset.a === "cancel") { S.recForm = false; renderRec(); return; }
      if (b.dataset.a === "ok") {
        var f = $("bg-recform"), get = function (k) { return f.querySelector("[data-f=" + k + "]").value; };
        var name = get("name").trim(), amt = parseAmt(get("amt")), day = parseInt(get("day"), 10);
        if (!name) { toast("填个名称", "bad"); return; }
        if (!amt || isNaN(amt) || amt <= 0) { toast("金额看不懂", "bad"); return; }
        if (!(day >= 1 && day <= 31)) { toast("几号要在 1 到 31 之间", "bad"); return; }
        S.data.recurring.push({ id: "r" + uid(), name: name.slice(0, 30), amt: amt, day: day, kind: get("kind"), cat: get("kind") === "in" ? "" : get("cat") });
        S.recForm = false;
        changed();
        return;
      }
      if (b.dataset.a === "del") {
        var id = b.closest(".bg-rrow").dataset.id;
        S.data.recurring = S.data.recurring.filter(function (r) { return r.id !== id; });
        changed();
      }
    });

    $("bg-csv").addEventListener("click", function () { exportCsv(false); });
    $("bg-csvall").addEventListener("click", function () { exportCsv(true); });
    $("bg-json").addEventListener("click", function () {
      download("budget-backup-" + today() + ".json", JSON.stringify(S.data, null, 1), "application/json");
    });
    $("bg-import").addEventListener("click", function () { $("bg-file").click(); });
    $("bg-file").addEventListener("change", function () { if (this.files[0]) importCsv(this.files[0]); this.value = ""; });

    /* 打码：截图、共享屏幕时用；鼠标悬停单个数字可以看 */
    var mk = $("bg-mask");
    function applyMask(on) {
      document.body.classList.toggle("bg-masked", on);
      mk.classList.toggle("on", on);
      try { localStorage.setItem(MASKKEY, on ? "1" : ""); } catch (e) {}
    }
    try { applyMask(localStorage.getItem(MASKKEY) === "1"); } catch (e) {}
    mk.addEventListener("click", function () { applyMask(!document.body.classList.contains("bg-masked")); });

    document.addEventListener("keydown", function (e) {
      if (!S.connected || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      if (document.querySelector("#askMask.show")) return;
      if (e.key === "/") { e.preventDefault(); $("bg-q").focus(); }
      else if (e.key === "[") goMonth(shiftMonth(S.month, -1));
      else if (e.key === "]") goMonth(shiftMonth(S.month, 1));
      else if (e.key === "n") { e.preventDefault(); $("a-amt").focus(); }
      else if (e.key === "h") applyMask(!document.body.classList.contains("bg-masked"));
    });
    window.addEventListener("beforeunload", function (e) {
      if (S.pending || S.saving) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  function boot() {
    bind();
    var saved = null;
    try { saved = localStorage.getItem(KEYNAME); } catch (e) {}
    if (saved) connect(saved).catch(function (e) { failConnect(e, saved); });
    else showLock("");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
