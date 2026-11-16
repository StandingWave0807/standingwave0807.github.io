/* 手机 App：记账 / 预算 / 日程 / 设置。数据格式和电脑上的预算页、日程页完全一样，
   电脑上能做的事这里都能做：按月分配、结余结转、固定收支、分类增删改排、趋势；日程的增删改、重复、提醒、分类。
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
  var CATCOL = ["#e8833a", "#d9534f", "#3a8fd9", "#5cb85c", "#8e6bd1", "#e0a800", "#17a2b8", "#c06c84", "#6c757d", "#2f9e8f"];
  var REPN = { none: "不重复", daily: "每天", weekdays: "工作日", weekly: "每周", biweekly: "每两周", monthly: "每月", yearly: "每年" };
  var REMN = [["", "不提醒"], ["0", "开始时"], ["5", "提前 5 分钟"], ["10", "提前 10 分钟"], ["15", "提前 15 分钟"],
              ["30", "提前 30 分钟"], ["60", "提前 1 小时"], ["120", "提前 2 小时"], ["1440", "提前 1 天"]];
  var DEFAULT_CATS = [["rent", "房租水电"], ["food", "吃饭"], ["trans", "交通"], ["daily", "日用"],
                      ["study", "学习"], ["fun", "娱乐"], ["save", "存下来", true]];
  var SHORTCUT = "邻苯日程提醒";
  var PREF = "phenol-app-";
  var TITLES = { money: "记账", stats: "统计", plan: "预算", cal: "日程", set: "设置" };

  var S = { tab: "money", budget: null, cal: null, month: "", filter: null, q: "", searching: false,
            calMonth: "", sel: "", fold: false, started: false };

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
  function rel(s) {
    var r = diff(today(), s);
    return r === 0 ? "今天" : r === 1 ? "明天" : r === 2 ? "后天" : r === -1 ? "昨天" : r === -2 ? "前天" : r > 0 ? r + " 天后" : (-r) + " 天前";
  }
  function monLabel(m) { return (+m.slice(0, 4)) + " 年 " + (+m.slice(5, 7)) + " 月"; }
  function initial(s) { return String(s || "?").trim().charAt(0) || "?"; }

  /* 触感：iOS 18+ Safari 点开关会震一下，借一个藏起来的开关；安卓走 vibrate */
  var hapEl = null;
  function haptic(n) {
    try {
      if (navigator.vibrate && !/iP(hone|ad|od)/.test(navigator.userAgent)) { navigator.vibrate(n > 1 ? [12, 60, 12] : 10); return; }
      if (!hapEl) {
        hapEl = document.createElement("label");
        hapEl.setAttribute("aria-hidden", "true");
        hapEl.style.cssText = "position:fixed;left:-99px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
        hapEl.innerHTML = '<input type="checkbox" switch tabindex="-1">';
        document.body.appendChild(hapEl);
      }
      hapEl.click();
      if (n > 1) setTimeout(function () { hapEl.click(); }, 90);
    } catch (e) {}
  }
  function toast(text, kind, action, ms) {
    if (kind === "bad") haptic(2);
    var el = $("toast");
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
  /* 系统 confirm 在主屏 App 里很丑，用自己的 */
  function ask(text, okLabel, danger) {
    return new Promise(function (res) {
      var m = sheet('<p style="margin:6px 2px 4px;font-size:15.5px">' + esc(text) + "</p>" +
        '<div class="acts"><button type="button" class="btn" data-x="no">取消</button>' +
        '<button type="button" class="btn ' + (danger ? "danger" : "pri") + '" data-x="ok">' + esc(okLabel || "确定") + "</button></div>",
        function () { res(false); });
      m.addEventListener("click", function (e) {
        var x = e.target.closest("[data-x]");
        if (!x) return;
        close(m);
        res(x.dataset.x === "ok");
      });
    });
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
    d.goals = Array.isArray(d.goals) ? d.goals : [];
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
    d.todos = Array.isArray(d.todos) ? d.todos : [];
    return d;
  }

  /* 改了就：存本机加密副本 → 排一次同步 → 重画 */
  function changed(name) {
    var d = name === "budget" ? S.budget : S.cal;
    LabSync.putLocal("local:" + name, d).catch(function () {});
    LabSync.kick(name, 1200);
    render();
  }

  /* ------------------------------------------------------------ 预算计算（和电脑页同一套） */
  function catById(id) { return S.budget.categories.filter(function (c) { return c.id === id; })[0] || null; }
  function catName(id) { var c = catById(id); return c ? c.name : "未分类"; }
  function catColor(id) {
    if (!id) return "#9a9a96";
    var i = S.budget.categories.findIndex(function (c) { return c.id === id; });
    return i < 0 ? "#9a9a96" : CATCOL[i % CATCOL.length];
  }
  function dot(id, name, kind) {
    var col = kind === "in" ? "var(--ok)" : catColor(id);
    return '<span class="dot" style="background:' + col + '">' + esc(kind === "in" ? "收" : initial(name)) + "</span>";
  }
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
    var a = allocOf(mo), sp = spentBy(mo), carry = carryTo(mo);
    var rows = [], allocSum = 0, availSum = 0;
    S.budget.categories.forEach(function (c) {
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
  function recDone(r, mo) { return S.budget.tx.some(function (t) { return t.rec === r.id && (t.d || "").slice(0, 7) === mo; }); }
  function learned() { return Bills.learn(S.budget.tx); }
  function barClass(r, f) {
    var avail = r.alloc + r.carry;
    if (r.spent > avail && (avail > 0 || r.spent)) return avail > 0 ? "over" : "none";
    if (avail > 0 && r.spent / avail > Math.max(f, .85)) return "warn";
    return "";
  }
  function barColor(cls, id) {
    return cls === "over" ? "var(--bad)" : cls === "warn" ? "var(--warn)" : cls === "none" ? "var(--faint)" : catColor(id);
  }
  function monSwitch(mo, act) {
    return '<div class="mon"><button type="button" data-a="' + act + '-prev" aria-label="上个月">‹</button><b>' + monLabel(mo) + "</b>" +
      '<button type="button" data-a="' + act + '-next" aria-label="下个月">›</button>' +
      (mo !== thisMonth() ? '<button type="button" class="now" data-a="' + act + '-now">本月</button>' : "") + "</div>";
  }

  /* ------------------------------------------------------------ 记账页 */
  function renderMoney() {
    var v = $("v-money"), mo = S.month, k = calc(mo), f = elapsed(mo), left = k.availSum - k.out;
    var h = monSwitch(mo, "m");

    h += '<div class="card hero">';
    if (k.availSum > 0) {
      var used = k.out / k.availSum, cls = left < 0 ? "over" : used > Math.max(f, .85) ? "warn" : "";
      h += '<div class="k">' + (mo === thisMonth() ? "这个月还能花" : mo < thisMonth() ? "这个月剩下" : "这个月可花") + "</div>" +
        '<div class="big num ' + (left < 0 ? "neg" : "") + '">' + esc(fmt(left)) + "</div>";
      if (mo === thisMonth()) {
        var dleft = daysIn(mo) - new Date().getDate() + 1;
        h += '<div class="sub">每天 <b class="num">' + esc(fmt(Math.max(0, Math.floor(left / dleft)))) + "</b> · 还剩 " + dleft + " 天</div>";
      } else {
        h += '<div class="sub">预算 ' + esc(fmt(k.availSum)) + "（含结转）</div>";
      }
      h += '<div class="pace"><i class="' + cls + '" style="width:' + Math.min(100, used * 100).toFixed(1) + '%"></i>' +
        (f > 0 && f < 1 ? '<b style="left:' + (f * 100).toFixed(1) + '%"></b>' : "") + "</div>";
      h += '<div class="hint">' + paceText(k, f) + "</div>";
    } else {
      h += '<div class="k">这个月花了</div><div class="big num">' + esc(fmt(k.out)) + "</div>" +
        '<div class="sub">还没给分类分配预算。<button type="button" class="link" data-a="goplan" style="color:var(--fg);font-weight:600;padding:0">去分配 ›</button></div>';
    }
    h += '<div class="trio"><div><small>支出</small><span class="num">' + esc(fmt(k.out)) + "</span></div>" +
      '<div><small>收入</small><span class="num">' + esc(fmt(k.income)) + "</span></div>" +
      '<div><small>结余</small><span class="num ' + (k.income - k.out < 0 ? "neg" : "") + '">' + esc(fmt(k.income - k.out)) + "</span></div></div></div>";

    var pend = S.budget.recurring.filter(function (r) { return !recDone(r, mo); });
    if (pend.length) {
      h += '<div class="banner"><span class="grow">还有 ' + pend.length + " 项固定收支没记：" +
        esc(pend.slice(0, 2).map(function (r) { return r.name; }).join("、")) + (pend.length > 2 ? " 等" : "") + "</span>" +
        '<button class="btn sm pri" type="button" data-a="rec">记上</button></div>';
    }

    h += alertHtml(k, f);

    /* 分类：只列这个月有花费或有预算的，点一下筛流水 */
    var rows = k.rows.filter(function (r) { return r.spent || r.alloc + r.carry; })
      .sort(function (a, b) { return b.spent - a.spent; });
    if (rows.length) {
      h += '<div class="sec"><h2>分类</h2><button type="button" class="r" data-a="goplan">调预算</button></div><div class="list">';
      rows.forEach(function (r) {
        var avail = r.alloc + r.carry, cls = barClass(r, f);
        var pct = avail > 0 ? Math.min(100, r.spent / avail * 100) : (r.spent ? 100 : 0);
        h += '<div class="cat tap' + (S.filter === r.c.id ? " sel" : "") + '" data-cat="' + esc(r.c.id) + '">' + dot(r.c.id, r.c.name) +
          '<div class="mid"><div class="t"><span class="nm">' + esc(r.c.name) + '</span><span class="num">' + esc(fmt(r.spent)) +
          (avail ? ' <span class="dim">/ ' + esc(fmt(avail)) + "</span>" : "") + "</span></div>" +
          '<div class="bar"><i style="width:' + pct.toFixed(1) + "%;background:" + barColor(cls, r.c.id) + '"></i></div></div></div>';
      });
      h += "</div>";
    }

    /* 流水 */
    var list = monthTx(mo).filter(txMatches).sort(function (a, b) {
      return a.d !== b.d ? (a.d < b.d ? 1 : -1) : (b.ts || 0) - (a.ts || 0);
    });
    h += '<div class="sec"><h2>流水 <span class="dim small" style="font-weight:400">' + list.length + " 笔</span></h2>" +
      '<button type="button" class="r" data-a="search">' + (S.searching ? "收起" : "搜索") + "</button></div>";
    if (S.searching) h += '<div class="search"><input type="search" id="q" placeholder="备注、分类、金额" value="' + esc(S.q) + '" enterkeyhint="search"></div>';
    if (S.filter !== null) {
      h += '<div class="filter"><span class="chip on">' + esc(S.filter ? catName(S.filter) : "未分类") +
        ' <span data-a="unfilter" style="margin-left:4px">✕</span></span></div>';
    }
    if (!list.length) {
      h += '<div class="list"><div class="empty">' + (S.q || S.filter !== null ? "没有对得上的流水" : "这个月还没记账，点右下角 ＋") + "</div></div>";
    }
    var last = "", sums = {};
    list.forEach(function (t) { if (t.kind !== "in") sums[t.d] = (sums[t.d] || 0) + t.amt; });
    list.forEach(function (t, i) {
      if (t.d !== last) {
        if (last) h += "</div>";
        last = t.d;
        h += '<div class="day" id="day-' + t.d + '"><span>' + esc(nice(t.d)) + (t.d === today() ? " · 今天" : t.d === add(today(), -1) ? " · 昨天" : "") +
          '</span><span class="num">' + (sums[t.d] ? "支出 " + esc(fmt(sums[t.d])) : "") + '</span></div><div class="list">';
      }
      var name = t.kind === "in" ? "收入" : catName(t.cat);
      h += '<div class="it" data-id="' + esc(t.id) + '"><div class="in">' + dot(t.cat, name, t.kind) +
        '<div class="nm"><div>' + esc(t.note || name) + "</div>" +
        '<div class="sub">' + esc(name) + (t.src ? " · " + esc(t.src) : "") + (t.rec ? " · 固定" : "") + "</div></div>" +
        '<span class="num ' + (t.kind === "in" ? "pos" : "") + '">' + esc(fmt(t.kind === "in" ? t.amt : -t.amt, true)) + "</span></div>" +
        '<button type="button" class="del" data-del="' + esc(t.id) + '">删除</button></div>';
      if (i === list.length - 1) h += "</div>";
    });
    v.innerHTML = h;
  }
  function paceText(k, f) {
    if (f === 0) return "这个月还没到，可以先把分配排好。";
    var used = k.out / k.availSum, d = Math.round((used - f) * 100);
    if (f >= 1) return "已结束：预算用掉 " + Math.round(used * 100) + "%" + (used > 1 ? '，<span class="bad">超支 ' + esc(fmt(k.out - k.availSum)) + "</span>" : "");
    return "时间过了 " + Math.round(f * 100) + "%，钱花了 " + Math.round(used * 100) + "%，" +
      (d > 3 ? '<span class="bad">快了 ' + d + " 个点</span>" : d < -3 ? '<span class="ok">慢了 ' + (-d) + " 个点</span>" : "刚好跟上");
  }
  function txMatches(t) {
    if (S.filter !== null && (t.kind === "in" || (t.cat || "") !== S.filter)) return false;
    if (!S.q) return true;
    var q = S.q.toLowerCase();
    return (t.note || "").toLowerCase().indexOf(q) >= 0 ||
      (t.kind === "in" ? "收入" : catName(t.cat)).toLowerCase().indexOf(q) >= 0 ||
      plain(t.amt).indexOf(q) >= 0 || (t.src || "").toLowerCase().indexOf(q) >= 0;
  }

  /* 左滑删除 */
  function bindSwipe(root) {
    var sx = 0, sy = 0, el = null, dx = 0, moving = false;
    root.addEventListener("touchstart", function (e) {
      var it = e.target.closest(".it");
      [].forEach.call(root.querySelectorAll(".it.open"), function (o) { if (o !== it) o.classList.remove("open"); });
      if (!it || e.target.closest(".del")) { el = null; return; }
      el = it; sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; moving = false;
    }, { passive: true });
    root.addEventListener("touchmove", function (e) {
      if (!el) return;
      var x = e.touches[0].clientX - sx, y = e.touches[0].clientY - sy;
      if (!moving && Math.abs(y) > Math.abs(x)) { el = null; return; }
      if (Math.abs(x) > 8) moving = true;
      if (!moving) return;
      dx = Math.max(-100, Math.min(0, x + (el.classList.contains("open") ? -84 : 0)));
      el.firstChild.style.transition = "none";
      el.firstChild.style.transform = "translateX(" + dx + "px)";
    }, { passive: true });
    root.addEventListener("touchend", function () {
      if (!el || !moving) { el = null; return; }
      el.firstChild.style.transition = "";
      el.firstChild.style.transform = "";
      if ((dx < -40) !== el.classList.contains("open")) haptic(1);
      el.classList.toggle("open", dx < -40);
      el.dataset.swiped = "1";
      setTimeout(function (x) { delete x.dataset.swiped; }, 350, el);
      el = null;
    });
  }

  function bindMoney() {
    var v = $("v-money");
    bindSwipe(v);
    v.addEventListener("click", function (e) {
      var a = e.target.closest("[data-a]"), c = e.target.closest("[data-cat]"), del = e.target.closest("[data-del]"), it = e.target.closest(".it");
      if (a) {
        var act = a.dataset.a;
        if (act === "m-prev") { S.month = shiftMonth(S.month, -1); S.filter = null; render(); }
        if (act === "m-next") { S.month = shiftMonth(S.month, 1); S.filter = null; render(); }
        if (act === "m-now") { S.month = thisMonth(); S.filter = null; render(); }
        if (act === "rec") applyRec();
        if (act === "goplan") go("plan");
        if (act === "unfilter") { S.filter = null; render(); }
        if (act === "search") {
          S.searching = !S.searching;
          if (!S.searching) S.q = "";
          render();
          if (S.searching && $("q")) $("q").focus();
        }
        return;
      }
      if (c) { S.filter = S.filter === c.dataset.cat ? null : c.dataset.cat; render(); return; }
      if (del) { removeTx(del.dataset.del); return; }
      if (it) {
        if (it.dataset.swiped) return;
        if (it.classList.contains("open")) { it.classList.remove("open"); return; }
        var t = S.budget.tx.filter(function (x) { return x.id === it.dataset.id; })[0];
        if (t) txSheet(t);
      }
    });
    v.addEventListener("input", function (e) {
      if (e.target.id !== "q") return;
      S.q = e.target.value.trim();
      clearTimeout(bindMoney.t);
      bindMoney.t = setTimeout(function () {
        var pos = e.target.selectionStart;
        S.deferred = false;
        renderMoney();
        var q = $("q");
        if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) {} }
      }, 250);
    });
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

  /* ------------------------------------------------------------ 预算页：电脑上的全部控制 */
  function renderPlan() {
    var v = $("v-plan"), mo = S.month, k = calc(mo), f = elapsed(mo);
    var unalloc = k.income - k.allocSum, left = k.availSum - k.out;
    var h = monSwitch(mo, "p");
    function tile(name, val, sub, cls) {
      return '<div class="tile ' + (cls || "") + '"><small>' + esc(name) + '</small><div class="num">' + esc(val) + '</div><div class="s">' + (sub || "&nbsp;") + "</div></div>";
    }
    h += '<div class="tiles">' +
      tile("收入", fmt(k.income), monthTx(mo).filter(function (t) { return t.kind === "in"; }).length + " 笔") +
      tile("待分配", fmt(unalloc), unalloc < 0 ? "分出去的比挣的多" : unalloc ? "还没安排的钱" : (k.income ? "每一块都有去处" : "先记收入"),
           unalloc < 0 ? "bad" : unalloc === 0 && k.income ? "ok" : "") +
      tile("已分配", fmt(k.allocSum), k.income ? Math.round(k.allocSum / k.income * 100) + "% 的收入" : "") +
      tile("预算剩余", fmt(left), "含结转", left < 0 ? "bad" : "") +
      tile("已花", fmt(k.out), k.availSum ? Math.round(k.out / k.availSum * 100) + "% 的预算" : "") +
      (mo === thisMonth()
        ? tile("每天还能花", fmt(Math.max(0, Math.floor(left / (daysIn(mo) - new Date().getDate() + 1)))), "剩 " + (daysIn(mo) - new Date().getDate() + 1) + " 天", left < 0 ? "bad" : "")
        : tile("本月结余", fmt(k.income - k.out), "收入 − 支出", k.income - k.out < 0 ? "bad" : "ok")) +
      "</div>";
    if (k.availSum) h += '<div class="card" style="margin-top:10px"><div class="hint">' + paceText(k, f) + "</div></div>";
    h += '<div class="acts2"><button class="btn" type="button" data-a="copy">照上月填</button>' +
      '<button class="btn" type="button" data-a="fill">待分配按上月摊</button></div>';

    h += '<div class="sec"><h2>分配</h2><button type="button" class="r" data-a="addcat">＋ 分类</button></div><div class="list">';
    if (!k.rows.length) h += '<div class="empty">还没有分类</div>';
    k.rows.forEach(function (r) {
      var avail = r.alloc + r.carry, cls = barClass(r, f);
      var pct = avail > 0 ? Math.min(100, r.spent / avail * 100) : (r.spent ? 100 : 0);
      var meta = [];
      meta.push(r.loose ? "没有分类的支出" : "分配 " + fmt(r.alloc));
      if (r.carry) meta.push("结转 " + fmt(r.carry, true));
      h += '<div class="cat tap" data-pcat="' + esc(r.c.id) + '">' + dot(r.c.id, r.c.name) +
        '<div class="mid"><div class="t"><span class="nm">' + esc(r.c.name) + (r.c.roll ? '<span class="tag">滚</span>' : "") +
        (r.c.hidden ? '<span class="tag">隐藏</span>' : "") + '</span><span class="num ' + (r.left < 0 ? "neg" : "") + '">剩 ' + esc(fmt(r.left)) + "</span></div>" +
        '<div class="bar"><i style="width:' + pct.toFixed(1) + "%;background:" + barColor(cls, r.c.id) + '"></i>' +
        (f > 0 && f < 1 && avail > 0 ? '<b style="left:' + (f * 100).toFixed(1) + '%"></b>' : "") + "</div>" +
        '<div class="meta"><span>' + esc(meta.join(" · ")) + '</span><span class="num">花 ' + esc(fmt(r.spent)) + "</span></div></div></div>";
    });
    var hiddenN = S.budget.categories.filter(function (c) { return c.hidden && !k.rows.some(function (r) { return r.c === c; }); }).length;
    h += "</div>";
    if (hiddenN) h += '<p class="dim small" style="margin:8px 6px">还有 ' + hiddenN + ' 个隐藏的分类。<button type="button" class="link" data-a="hidden" style="color:var(--fg)">看看</button></p>';

    var pend = S.budget.recurring.filter(function (r) { return !recDone(r, mo); }).length;
    h += '<div class="sec"><h2>固定收支 <span class="dim small" style="font-weight:400">每月自动提醒</span></h2>' +
      '<button type="button" class="r" data-a="addrec">＋ 添加</button></div><div class="list">';
    if (!S.budget.recurring.length) h += '<div class="empty">房租、工资、订阅……加上以后每月一键记</div>';
    S.budget.recurring.slice().sort(function (a, b) { return a.day - b.day; }).forEach(function (r) {
      var done = recDone(r, mo);
      h += '<div class="cell tap' + (done ? " done" : "") + '" data-rec="' + esc(r.id) + '">' + dot(r.cat, r.kind === "in" ? "收入" : catName(r.cat), r.kind) +
        '<div class="grow"><div>' + esc(r.name) + '</div><div class="sub">每月 ' + r.day + " 号 · " + esc(r.kind === "in" ? "收入" : catName(r.cat)) +
        (done ? " · 本月已记" : "") + "</div></div>" +
        '<span class="num ' + (r.kind === "in" ? "pos" : "") + '">' + (done ? "✓ " : "") + esc(fmt(r.kind === "in" ? r.amt : -r.amt, true)) + "</span></div>";
    });
    h += "</div>";
    if (pend) h += '<button class="btn wide" type="button" data-a="rec" style="margin-top:10px;background:var(--card)">把本月没记的 ' + pend + " 项记上</button>";

    h += goalsHtml();
    h += '<div class="sec"><h2>近六个月</h2></div><div class="card trend">' + trendSvg(mo) +
      '<div class="legend"><span><i style="background:var(--acc)"></i>支出</span><span><i style="background:var(--ok);opacity:.35"></i>收入</span></div></div>';
    v.innerHTML = h;
  }
  function trendSvg(mo) {
    var months = [], i;
    for (i = 5; i >= 0; i--) months.push(shiftMonth(mo, -i));
    var vals = months.map(function (m) { var s = spentBy(m); return { mo: m, inc: s.income, out: s.out }; });
    var max = 1;
    vals.forEach(function (x) { max = Math.max(max, x.inc, x.out); });
    var W = 600, H = 230, top = 26, bot = 32, ch = H - top - bot, bw = W / 6;
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="近六个月收支">';
    vals.forEach(function (x, j) {
      var X = j * bw, oh = x.out / max * ch, ih = x.inc / max * ch;
      if (x.inc) svg += '<rect class="rin" rx="6" x="' + (X + bw * .16) + '" y="' + (top + ch - ih) + '" width="' + (bw * .68) + '" height="' + ih + '"></rect>';
      svg += '<rect class="rout" rx="6" x="' + (X + bw * .3) + '" y="' + (top + ch - oh) + '" width="' + (bw * .4) + '" height="' + Math.max(oh, x.out ? 2 : 0) + '"></rect>';
      if (x.out) svg += '<text class="v" x="' + (X + bw / 2) + '" y="' + Math.max(18, top + ch - Math.max(oh, ih) - 7) + '" text-anchor="middle">' + esc(short(x.out)) + "</text>";
      svg += '<text x="' + (X + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle"' + (x.mo === mo ? ' style="fill:var(--fg);font-weight:700"' : "") + ">" + (+x.mo.slice(5)) + "月</text>";
    });
    return svg + '<line class="ax" x1="0" x2="' + W + '" y1="' + (top + ch) + '" y2="' + (top + ch) + '"></line></svg>';
  }
  function short(c) { var y = c / 100; return y >= 10000 ? (y / 10000).toFixed(1).replace(/\.0$/, "") + "万" : String(Math.round(y)); }

  function bindPlan() {
    $("v-plan").addEventListener("click", function (e) {
      var a = e.target.closest("[data-a]"), pc = e.target.closest("[data-pcat]"), rc = e.target.closest("[data-rec]");
      var ga = e.target.closest("[data-gadd]"), gl = e.target.closest("[data-goal]");
      if (ga) { var g1 = S.budget.goals.filter(function (x) { return x.id === ga.dataset.gadd; })[0]; if (g1) goalMoveSheet(g1); return; }
      if (gl) { var g2 = S.budget.goals.filter(function (x) { return x.id === gl.dataset.goal; })[0]; if (g2) goalSheet(g2); return; }
      if (a) {
        var act = a.dataset.a;
        if (act === "p-prev") { S.month = shiftMonth(S.month, -1); render(); }
        if (act === "p-next") { S.month = shiftMonth(S.month, 1); render(); }
        if (act === "p-now") { S.month = thisMonth(); render(); }
        if (act === "copy") copyLast();
        if (act === "fill") fillByLast();
        if (act === "rec") applyRec();
        if (act === "addcat") addCat();
        if (act === "addrec") recSheet(null);
        if (act === "addgoal") goalSheet(null);
        if (act === "hidden") hiddenSheet();
        return;
      }
      if (pc) {
        if (!pc.dataset.pcat) { S.filter = ""; go("money"); return; }
        var c = catById(pc.dataset.pcat);
        if (c) catSheet(c);
        return;
      }
      if (rc) {
        var r = S.budget.recurring.filter(function (x) { return x.id === rc.dataset.rec; })[0];
        if (r) recSheet(r);
      }
    });
  }
  function setAlloc(cat, v) {
    var mo = S.budget.months[S.month] = S.budget.months[S.month] || {};
    mo.alloc = mo.alloc || {};
    if (v) mo.alloc[cat] = v; else delete mo.alloc[cat];
  }
  function copyLast() {
    var prev = allocOf(shiftMonth(S.month, -1));
    if (!Object.keys(prev).length) { toast("上个月没有分配可以抄", "bad"); return; }
    var doit = function () {
      var mo = S.budget.months[S.month] = S.budget.months[S.month] || {};
      mo.alloc = JSON.parse(JSON.stringify(prev));
      changed("budget");
      toast("照上月填好了");
    };
    if (Object.keys(allocOf(S.month)).length) ask("这个月已经填过分配，用上个月的覆盖掉？", "覆盖").then(function (y) { if (y) doit(); });
    else doit();
  }
  /* 待分配的钱按上个月各分类实际花费的比例摊，取整到元；零头给花得最多的那类（和电脑页一样） */
  function fillByLast() {
    var k = calc(S.month), left = k.income - k.allocSum;
    if (left <= 0) { toast(k.income ? "没有待分配的钱" : "先记这个月的收入", "bad"); return; }
    var sp = spentBy(shiftMonth(S.month, -1)).cat, ids = [];
    S.budget.categories.forEach(function (c) { if (!c.hidden && sp[c.id] > 0) ids.push(c.id); });
    if (!ids.length) { toast("上个月没有分类花费可以参照", "bad"); return; }
    var total = ids.reduce(function (s, id) { return s + sp[id]; }, 0), given = 0;
    var mo = S.budget.months[S.month] = S.budget.months[S.month] || {};
    mo.alloc = mo.alloc || {};
    ids.sort(function (a, b) { return sp[b] - sp[a]; });
    ids.forEach(function (id) {
      var part = Math.floor(left * sp[id] / total / 100) * 100;
      mo.alloc[id] = (mo.alloc[id] || 0) + part;
      given += part;
    });
    mo.alloc[ids[0]] += left - given;
    changed("budget");
    toast("把 " + fmt(left) + " 按上月比例摊开了");
  }
  function addCat() {
    var m = sheet("<h3>新分类" + closeBtn() + '</h3><input type="text" id="nc" maxlength="20" placeholder="比如 咖啡、健身">' +
      '<label class="row" style="margin-top:12px;justify-content:space-between"><span>结余滚入下月<div class="dim small">没花完的带到下个月，超支也扣到下个月</div></span>' +
      '<span class="sw"><input type="checkbox" id="nr"><span></span></span></label>' +
      '<div class="acts"><button type="button" class="btn pri" data-x="ok">加上</button></div>');
    setTimeout(function () { m.querySelector("#nc").focus(); }, 60);
    m.addEventListener("click", function (e) {
      var x = e.target.closest("[data-x]");
      if (!x) return;
      if (x.dataset.x === "close") { close(m); return; }
      var v = m.querySelector("#nc").value.trim();
      if (!v) { toast("写个名字", "bad"); return; }
      if (S.budget.categories.some(function (c) { return c.name === v; })) { toast("已经有这个分类了", "bad"); return; }
      S.budget.categories.push({ id: "c" + uid(), name: v.slice(0, 20), roll: m.querySelector("#nr").checked, hidden: false });
      close(m);
      changed("budget");
      toast("加上了「" + v + "」");
    });
  }
  function catSheet(c) {
    var k = calc(S.month), r = k.rows.filter(function (x) { return x.c === c; })[0] || { alloc: 0, carry: 0, spent: 0, left: 0 };
    var list = S.budget.categories, i = list.indexOf(c), prevAlloc = allocOf(shiftMonth(S.month, -1))[c.id] || 0;
    var used = S.budget.tx.filter(function (t) { return t.cat === c.id; }).length;
    var m = sheet("<h3>" + esc(c.name) + closeBtn() + "</h3>" +
      '<div class="card"><div class="row" style="justify-content:space-between"><span class="dim small">' + monLabel(S.month) + " 分配</span>" +
      '<span class="dim small">本月花了 ' + esc(fmt(r.spent)) + (r.carry ? " · 结转 " + esc(fmt(r.carry, true)) : "") + "</span></div>" +
      '<input type="text" id="ca" inputmode="decimal" class="num" style="font-size:26px;font-weight:700;margin-top:6px;background:var(--press)" placeholder="0" value="' + (r.alloc ? plain(r.alloc) : "") + '">' +
      '<div class="chips" style="margin-top:8px">' +
      (prevAlloc ? '<button type="button" class="chip" data-set="' + prevAlloc + '">上月 ' + esc(fmt(prevAlloc)) + "</button>" : "") +
      (r.spent ? '<button type="button" class="chip" data-set="' + r.spent + '">刚好够已花的 ' + esc(fmt(r.spent)) + "</button>" : "") +
      '<button type="button" class="chip" data-set="0">清零</button></div>' +
      '<div class="dim small" style="margin-top:6px">可以写算式，比如 1500+300</div></div>' +
      '<div class="card"><label class="f" style="margin-top:0">名字</label><input type="text" id="cn" maxlength="20" value="' + esc(c.name) + '">' +
      '<label class="row" style="margin-top:14px;justify-content:space-between"><span>结余滚入下月<div class="dim small">没花完的带到下个月，超支也扣过去</div></span>' +
      '<span class="sw"><input type="checkbox" id="cr"' + (c.roll ? " checked" : "") + "><span></span></span></label>" +
      '<div class="row" style="margin-top:14px"><span class="grow dim small">排序</span>' +
      '<button type="button" class="btn sm" data-x="up"' + (i > 0 ? "" : " disabled") + ">上移</button>" +
      '<button type="button" class="btn sm" data-x="down"' + (i < list.length - 1 ? "" : " disabled") + ">下移</button></div></div>" +
      '<div class="acts"><button type="button" class="btn danger" data-x="del">' + (c.hidden ? "重新显示" : used ? "隐藏" : "删除") + "</button>" +
      '<button type="button" class="btn pri" data-x="save">保存</button></div>');
    var q = function (id) { return m.querySelector("#" + id); };
    m.addEventListener("click", function (e) {
      var st = e.target.closest("[data-set]"), x = e.target.closest("[data-x]");
      if (st) { q("ca").value = +st.dataset.set ? plain(+st.dataset.set) : ""; return; }
      if (!x) return;
      var act = x.dataset.x;
      if (act === "close") { close(m); return; }
      if (act === "up" || act === "down") {
        var j = list.indexOf(c), to = act === "up" ? j - 1 : j + 1;
        if (to < 0 || to >= list.length) return;
        list.splice(to, 0, list.splice(j, 1)[0]);
        changed("budget");
        x.parentNode.querySelector('[data-x="up"]').disabled = to === 0;
        x.parentNode.querySelector('[data-x="down"]').disabled = to === list.length - 1;
        toast(act === "up" ? "上移了" : "下移了", "", null, 1000);
        return;
      }
      if (act === "del") {
        if (c.hidden) { c.hidden = false; close(m); changed("budget"); toast("「" + c.name + "」重新显示了"); return; }
        if (used) {
          ask("「" + c.name + "」下面有 " + used + " 笔流水，删了账就对不上。改成隐藏？旧账照常统计，记账时不再出现。", "隐藏").then(function (y) {
            if (!y) return;
            c.hidden = true; close(m); changed("budget");
          });
        } else {
          ask("删掉分类「" + c.name + "」？各月给它的分配额也一起去掉。", "删除", true).then(function (y) {
            if (!y) return;
            list.splice(list.indexOf(c), 1);
            Object.keys(S.budget.months).forEach(function (kk) { var a = S.budget.months[kk].alloc; if (a) delete a[c.id]; });
            close(m); changed("budget");
          });
        }
        return;
      }
      var v = parseAmt(q("ca").value);
      if (v === null) v = 0;
      if (isNaN(v) || v < 0) { toast("分配额看不懂", "bad"); return; }
      var nm = q("cn").value.trim();
      if (!nm) { toast("名字不能空", "bad"); return; }
      if (nm !== c.name && list.some(function (o) { return o !== c && o.name === nm; })) { toast("已经有这个分类了", "bad"); return; }
      c.name = nm.slice(0, 20);
      c.roll = q("cr").checked;
      setAlloc(c.id, v);
      close(m);
      changed("budget");
      toast(c.name + "：" + monLabel(S.month).replace(/^\d+ 年 /, "") + "分配 " + fmt(v));
    });
  }
  function hiddenSheet() {
    var hid = S.budget.categories.filter(function (c) { return c.hidden; });
    var m = sheet("<h3>隐藏的分类" + closeBtn() + '</h3><div class="list">' + hid.map(function (c) {
      return '<div class="cell"><div class="grow">' + esc(c.name) + '</div><button type="button" class="btn sm" data-show="' + esc(c.id) + '">显示</button></div>';
    }).join("") + "</div>");
    m.addEventListener("click", function (e) {
      var s = e.target.closest("[data-show]"), x = e.target.closest("[data-x]");
      if (x) { close(m); return; }
      if (!s) return;
      var c = catById(s.dataset.show);
      if (c) { c.hidden = false; changed("budget"); s.closest(".cell").remove(); }
      if (!m.querySelector(".cell")) close(m);
    });
  }
  function recSheet(r) {
    var isNew = !r, e = r || { name: "", amt: 0, day: 1, kind: "out", cat: "" }, kind = e.kind, cat = e.cat || "";
    var cats = S.budget.categories.filter(function (c) { return !c.hidden || c.id === cat; });
    var m = sheet("<h3>" + (isNew ? "新的固定收支" : "固定收支") + closeBtn() + "</h3>" +
      '<div class="seg" id="r-kind"><button type="button" data-k="out" class="' + (kind === "out" ? "on" : "") + '">支出</button>' +
      '<button type="button" data-k="in" class="' + (kind === "in" ? "on" : "") + '">收入</button></div>' +
      '<label class="f">名称</label><input type="text" id="r-name" maxlength="30" placeholder="房租、工资、视频会员……" value="' + esc(e.name) + '">' +
      '<div class="two"><div><label class="f">金额</label><input type="text" id="r-amt" inputmode="decimal" class="num" value="' + (e.amt ? plain(e.amt) : "") + '"></div>' +
      '<div><label class="f">每月几号</label><select id="r-day">' + (function () {
        var o = ""; for (var d = 1; d <= 31; d++) o += '<option value="' + d + '"' + (d === e.day ? " selected" : "") + ">" + d + " 号" + (d > 28 ? "（月小取月底）" : "") + "</option>"; return o;
      })() + "</select></div></div>" +
      '<div id="r-catw"' + (kind === "in" ? " hidden" : "") + '><label class="f">分类</label><div class="chips" id="r-cats">' +
      cats.map(function (c) { return '<button type="button" class="chip' + (cat === c.id ? " on" : "") + '" data-c="' + esc(c.id) + '"><i style="background:' + catColor(c.id) + '"></i>' + esc(c.name) + "</button>"; }).join("") +
      "</div></div>" +
      (isNew ? "" : '<p class="dim small" style="margin:12px 2px 0">改动只影响以后；已经记进流水的不动。</p>') +
      '<div class="acts">' + (isNew ? "" : '<button type="button" class="btn danger" data-x="del">删除</button>') +
      '<button type="button" class="btn pri" data-x="save">' + (isNew ? "加上" : "保存") + "</button></div>");
    var q = function (id) { return m.querySelector("#" + id); };
    if (isNew) setTimeout(function () { q("r-name").focus(); }, 60);
    m.addEventListener("click", function (ev) {
      var k = ev.target.closest("[data-k]"), c = ev.target.closest("[data-c]"), x = ev.target.closest("[data-x]");
      if (k) { kind = k.dataset.k; [].forEach.call(q("r-kind").children, function (b) { b.classList.toggle("on", b === k); }); q("r-catw").hidden = kind === "in"; return; }
      if (c) { cat = cat === c.dataset.c ? "" : c.dataset.c; [].forEach.call(q("r-cats").children, function (b) { b.classList.toggle("on", b.dataset.c === cat); }); return; }
      if (!x) return;
      if (x.dataset.x === "close") { close(m); return; }
      if (x.dataset.x === "del") {
        ask("删掉「" + r.name + "」？已经记进流水的不动。", "删除", true).then(function (y) {
          if (!y) return;
          S.budget.recurring.splice(S.budget.recurring.indexOf(r), 1);
          close(m); changed("budget");
        });
        return;
      }
      var name = q("r-name").value.trim(), amt = parseAmt(q("r-amt").value);
      if (!name) { toast("写个名称", "bad"); return; }
      if (!amt || isNaN(amt) || amt <= 0) { toast("金额看不懂", "bad"); return; }
      var row = r || { id: "r" + uid() };
      row.name = name.slice(0, 30); row.amt = amt; row.day = +q("r-day").value; row.kind = kind; row.cat = kind === "in" ? "" : cat;
      if (isNew) S.budget.recurring.push(row);
      close(m);
      changed("budget");
      toast(isNew ? "加上了「" + row.name + "」" : "改好了");
    });
  }

  /* ------------------------------------------------------------ 弹层 */
  function closeBtn() { return '<button type="button" class="link" data-x="close">关闭</button>'; }
  function sheet(html, onDismiss) {
    var m = document.createElement("div");
    m.className = "mask";
    m.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>' + html + "</div>";
    document.body.appendChild(m);
    lockScroll(true);
    m.addEventListener("click", function (e) { if (e.target === m) { close(m); if (onDismiss) onDismiss(); } });
    /* 往下拖把手关掉 */
    var sy = null, sh = m.firstChild;
    sh.addEventListener("touchstart", function (e) { sy = sh.scrollTop <= 0 && e.target.closest(".grab,h3,.pad-top") && !e.target.closest("input,textarea,select") ? e.touches[0].clientY : null; }, { passive: true });
    sh.addEventListener("touchmove", function (e) { if (sy !== null) { var d = Math.max(0, e.touches[0].clientY - sy); sh.style.transition = "none"; sh.style.transform = "translateY(" + d + "px)"; m.style.background = "rgba(0,0,0," + (0.38 * Math.max(0, 1 - d / 400)) + ")"; } }, { passive: true });
    sh.addEventListener("touchend", function (e) {
      if (sy === null) return;
      var d = e.changedTouches[0].clientY - sy;
      sy = null;
      if (d > 90) { close(m); if (onDismiss) onDismiss(); } else { sh.style.transition = "transform .2s"; sh.style.transform = ""; m.style.background = ""; }
    });
    return m;
  }
  var lockY = 0, locked = false;
  function lockScroll(on) {
    var b = document.body;
    if (on && !locked) { lockY = window.scrollY; b.style.position = "fixed"; b.style.top = -lockY + "px"; b.style.left = "0"; b.style.right = "0"; locked = true; }
    if (!on && locked) { b.style.position = ""; b.style.top = ""; b.style.left = ""; b.style.right = ""; locked = false; window.scrollTo(0, lockY); }
  }
  function close(m) {
    if (!m || !m.parentNode || m.classList.contains("out")) return;
    m.classList.add("out");
    var sh = m.firstChild;
    if (sh && sh.style.transform) { sh.style.transition = "transform .2s"; sh.style.transform = "translateY(100%)"; }
    var done = false;
    function fin() { if (done) return; done = true; m.remove(); if (!document.querySelector(".mask:not(.out)")) lockScroll(false); }
    m.addEventListener("animationend", function (e) { if (e.target === m) fin(); });
    setTimeout(fin, 260);
  }

  /* 记一笔 / 改一笔 / 截图进来的一笔：同一个面板，自带数字键盘，不用唤起系统键盘。t 没有 id 就是新的。 */
  function catsByUse() {
    var cnt = {};
    S.budget.tx.slice(-400).forEach(function (t) { if (t.kind !== "in" && t.cat) cnt[t.cat] = (cnt[t.cat] || 0) + 1; });
    var cats = S.budget.categories.filter(function (c) { return !c.hidden; });
    var order = cats.map(function (c, i) { return { c: c, n: cnt[c.id] || 0, i: i }; });
    order.sort(function (a, b) { return b.n - a.n || a.i - b.i; });
    return order.map(function (x) { return x.c; });
  }
  function notesFor(cat, kind) {
    var cnt = {};
    S.budget.tx.slice(-600).forEach(function (t) {
      if (!t.note || t.kind !== kind) return;
      if (kind === "out" && cat && t.cat !== cat) return;
      cnt[t.note] = (cnt[t.note] || 0) + 1;
    });
    return Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).slice(0, 8);
  }
  function txSheet(t, opts) {
    t = t || {};
    opts = opts || {};
    var isNew = !t.id, kind = t.kind || "out", cat = t.cat || "", d = t.d || (S.month === thisMonth() ? today() : S.month + "-01");
    var expr = t.amt ? plain(t.amt) : "", src = t.src || "", catTouched = !!t.cat;
    var cats = catsByUse();
    if (cat && !cats.some(function (c) { return c.id === cat; }) && catById(cat)) cats.push(catById(cat));
    var m = sheet(
      '<div class="pad-top"><div class="seg" id="s-kind"><button type="button" data-k="out" class="' + (kind === "out" ? "on" : "") + '">支出</button>' +
      '<button type="button" data-k="in" class="' + (kind === "in" ? "on" : "") + '">收入</button></div>' +
      '<span class="dim small" style="flex:1;text-align:center">' + esc(opts.title || (isNew ? "" : "改这一笔")) + "</span>" + closeBtn() + "</div>" +
      (opts.hint ? '<p class="dim small" style="margin:2px 2px 0">' + esc(opts.hint) + "</p>" : "") +
      '<div class="amt-show" id="s-show"></div>' +
      '<div class="catgrid" id="s-cats"' + (kind === "in" ? " hidden" : "") + "></div>" +
      '<div class="notein"><input type="text" id="s-note" maxlength="60" placeholder="备注：商家、用途" value="' + esc(t.note || "") + '" enterkeyhint="done"></div>' +
      '<div class="quick" id="s-quick"></div>' +
      '<div class="dates" id="s-dates"></div>' +
      '<div class="keys" id="s-keys">' +
      "<button type=\"button\" data-n=\"7\">7</button><button type=\"button\" data-n=\"8\">8</button><button type=\"button\" data-n=\"9\">9</button><button type=\"button\" class=\"op\" data-n=\"back\">⌫</button>" +
      "<button type=\"button\" data-n=\"4\">4</button><button type=\"button\" data-n=\"5\">5</button><button type=\"button\" data-n=\"6\">6</button><button type=\"button\" class=\"op\" data-n=\"+\">＋</button>" +
      "<button type=\"button\" data-n=\"1\">1</button><button type=\"button\" data-n=\"2\">2</button><button type=\"button\" data-n=\"3\">3</button>" +
      '<button type="button" class="ok" data-x="save">' + (isNew ? "记上" : "保存") + "</button>" +
      "<button type=\"button\" data-n=\".\">.</button><button type=\"button\" data-n=\"0\">0</button><button type=\"button\" class=\"op\" data-n=\"-\">－</button></div>" +
      (isNew ? "" : '<button type="button" class="btn danger wide" data-x="del" style="margin-top:10px;background:var(--card)">删除这一笔</button>'));
    var q = function (id) { return m.querySelector("#" + id); };
    function paintAmt() {
      var v = parseAmt(expr), el = q("s-show");
      el.className = "amt-show" + (expr ? "" : " empty");
      el.innerHTML = '<span class="expr">' + (/[-+]/.test(expr.slice(1)) ? esc(expr.replace(/-/g, " − ").replace(/\+/g, " + ")) : "&nbsp;") + "</span>" +
        '<span class="cur">' + esc(cur()) + '</span><span class="v">' + (!expr ? "0" : !/[-+]/.test(expr.slice(1)) || v === null || isNaN(v) ? esc(expr.replace(/[-+]$/, "")) : esc(plain(v))) + "</span>";
    }
    function paintCats() {
      q("s-cats").innerHTML = cats.map(function (c) {
        return '<button type="button" data-c="' + esc(c.id) + '" class="' + (cat === c.id ? "on" : "") + '"><span class="dot" style="background:' + catColor(c.id) + '">' + esc(initial(c.name)) + "</span>" + esc(c.name) + "</button>";
      }).join("");
    }
    function paintQuick() {
      var ns = notesFor(cat, kind).filter(function (n) { return n !== q("s-note").value.trim(); }).slice(0, 6);
      q("s-quick").innerHTML = ns.map(function (n) { return '<button type="button" data-q="' + esc(n) + '">' + esc(n) + "</button>"; }).join("");
      q("s-quick").hidden = !ns.length;
    }
    function paintDates() {
      var t0 = today(), opts2 = [[t0, "今天"], [add(t0, -1), "昨天"], [add(t0, -2), "前天"]];
      var isQuick = opts2.some(function (o) { return o[0] === d; });
      q("s-dates").innerHTML = opts2.map(function (o) { return '<button type="button" data-d="' + o[0] + '" class="' + (d === o[0] ? "on" : "") + '">' + o[1] + "</button>"; }).join("") +
        '<label class="' + (isQuick ? "" : "on") + '">' + (isQuick ? "选日期" : esc(nice(d))) + '<input type="date" id="s-date" value="' + esc(d) + '"></label>' +
        '<span class="grow"></span>' +
        (src ? '<button type="button" data-src="1" title="去掉来源">' + esc(src) + " ✕</button>" : "");
    }
    paintAmt(); paintCats(); paintQuick(); paintDates();
    m.addEventListener("change", function (e) {
      if (e.target.id === "s-date" && validDate(e.target.value)) { d = e.target.value; paintDates(); }
      if (e.target.id === "s-note") {
        if (kind === "out" && !catTouched) {
          var g = Bills.guessCat(e.target.value, S.budget.categories, learned());
          if (g) { cat = g; [].forEach.call(q("s-cats").children, function (b) { b.classList.toggle("on", b.dataset.c === cat); }); }
        }
        paintQuick();
      }
    });
    q("s-note").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
    m.addEventListener("click", function (e) {
      var n = e.target.closest("[data-n]"), k = e.target.closest("[data-k]"), c = e.target.closest("[data-c]"),
          qq = e.target.closest("[data-q]"), dd = e.target.closest("[data-d]"), sr = e.target.closest("[data-src]"), x = e.target.closest("[data-x]");
      if (n) {
        var key = n.dataset.n;
        if (key === "back") expr = expr.slice(0, -1);
        else if (key === "+" || key === "-") { if (expr && !/[-+.]$/.test(expr)) expr += key; else if (expr && /[-+]$/.test(expr)) expr = expr.slice(0, -1) + key; }
        else if (key === ".") { var last = expr.split(/[-+]/).pop(); if (last.indexOf(".") < 0) expr += last ? "." : "0."; }
        else {
          var seg = expr.split(/[-+]/).pop();
          if (/\.\d\d$/.test(seg) || seg.replace(".", "").length >= 9) return;
          if (seg === "0") expr = expr.slice(0, -1);
          expr += key;
        }
        paintAmt();
        return;
      }
      if (k) {
        kind = k.dataset.k;
        [].forEach.call(q("s-kind").children, function (b) { b.classList.toggle("on", b === k); });
        q("s-cats").hidden = kind === "in";
        paintQuick();
        return;
      }
      if (c) {
        cat = cat === c.dataset.c ? "" : c.dataset.c;
        catTouched = true;
        [].forEach.call(q("s-cats").children, function (b) { b.classList.toggle("on", b.dataset.c === cat); });
        paintQuick();
        return;
      }
      if (qq) {
        q("s-note").value = qq.dataset.q;
        if (kind === "out" && !catTouched) {
          var g = Bills.guessCat(qq.dataset.q, S.budget.categories, learned());
          if (g) { cat = g; paintCats(); }
        }
        paintQuick();
        return;
      }
      if (dd) { d = dd.dataset.d; paintDates(); return; }
      if (sr) { src = ""; paintDates(); return; }
      if (!x) return;
      if (x.dataset.x === "close") { close(m); return; }
      if (x.dataset.x === "del") { close(m); removeTx(t.id); return; }
      var amt = parseAmt(expr);
      if (amt === null) { toast("先按金额", "bad"); return; }
      if (isNaN(amt) || amt <= 0) { toast("金额不对", "bad"); return; }
      if (!validDate(d)) { toast("日期不对", "bad"); return; }
      var note = q("s-note").value.trim();
      if (kind === "out" && !cat) cat = Bills.guessCat(note, S.budget.categories, learned()) || "";
      var row = isNew ? { id: uid(), ts: Date.now() } : t;
      row.amt = amt; row.kind = kind; row.cat = kind === "in" ? "" : cat; row.note = note; row.d = d;
      if (src) row.src = src; else delete row.src;
      if (t.ref) row.ref = t.ref;
      if (isNew) S.budget.tx.push(row);
      close(m);
      if (d.slice(0, 7) !== S.month) S.month = d.slice(0, 7);
      changed("budget");
      toast((isNew ? "记了 " : "改好了 ") + fmt(amt) + (row.cat ? " · " + catName(row.cat) : ""), "",
            isNew ? { label: "撤销", run: function () { removeTx(row.id, true); } } : null, 5000);
    });
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
          if (d >= from && d <= to) out.push({ ro: true, d: d, e: d, all: true, title: (b.kind === "in" ? "进账 · " : "付款 · ") + b.name + " " + fmt(b.amt), color: "var(--faint)" });
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
  /* 按天摊开：多天的全天日程每一天都算 */
  function byDay(items, from, to) {
    var r = {};
    items.forEach(function (it) {
      for (var d = it.d < from ? from : it.d; d <= it.e && d <= to; d = add(d, 1)) (r[d] = r[d] || []).push(it);
    });
    return r;
  }
  function remText(ev) {
    if (ev.remind === undefined || ev.remind === "" || ev.remind === null) return "";
    var r = REMN.filter(function (x) { return x[0] === String(ev.remind); })[0];
    return r ? "🔔 " + r[1].replace("提前 ", "") : "";
  }
  function evRow(it, d) {
    var sub = [];
    if (it.e > it.d) sub.push(nice(it.d).replace(/ 周.$/, "") + " – " + nice(it.e).replace(/ 周.$/, ""));
    if (it.ev && it.ev.rep && it.ev.rep !== "none") sub.push(REPN[it.ev.rep]);
    if (it.ev) { var r = remText(it.ev); if (r) sub.push(r); }
    if (it.ev && it.ev.note) sub.push(it.ev.note.split("\n")[0].slice(0, 40));
    return '<div class="ev' + (it.ro ? " ro" : " tap") + '"' + (it.ev ? ' data-id="' + esc(it.ev.id) + '" data-d="' + it.d + '"' : "") + ">" +
      '<span class="tm">' + (it.all || !it.t ? "全天" : esc(it.t) + (it.f ? "<small>" + esc(it.f) + "</small>" : "")) + "</span>" +
      '<span class="bar" style="background:' + esc(it.color) + '"></span>' +
      '<div class="nm">' + esc(it.title) + (sub.length ? '<div class="sub">' + esc(sub.join(" · ")) + "</div>" : "") + "</div></div>";
  }
  function renderCal() {
    var v = $("v-cal"), cm = S.calMonth, t0 = today();
    if (!S.sel) S.sel = t0;
    var first = cm + "-01", gStart = add(first, -dow(first));
    var weeks = Math.ceil((dow(first) + daysIn(cm)) / 7), gEnd = add(gStart, weeks * 7 - 1);
    var aEnd = add(t0, 7);
    var lo = gStart < t0 ? gStart : t0, hi = gEnd > aEnd ? gEnd : aEnd;
    if (S.sel < lo) lo = S.sel;
    if (S.sel > hi) hi = S.sel;
    var all = byDay(instances(lo, hi), lo, hi);
    var h = "";
    var due = reminderPayload(), sent = pref("remsig");
    if (due.items.length && sent !== due.sig) {
      h += '<div class="banner" style="margin:0 0 10px"><span class="grow">🔔 有 ' + due.items.length + " 个提醒还没推到 iPhone</span>" +
        '<button class="btn sm pri" type="button" data-a="push">推送</button></div>';
    }
    h += '<div class="mon" style="justify-content:space-between"><button type="button" data-a="c-prev" aria-label="上个月">‹</button><b>' + monLabel(cm) + "</b>" +
      '<button type="button" data-a="c-next" aria-label="下个月">›</button><span class="grow"></span>' +
      (S.sel !== t0 || cm !== t0.slice(0, 7) ? '<button type="button" class="now" data-a="c-today">今天</button>' : "") +
      '<button type="button" class="now" data-a="c-cats" style="margin-left:6px">分类</button></div>';
    h += '<div class="cal"><div class="wd">' + WD.split("").map(function (w) { return "<span>" + w + "</span>"; }).join("") + '</div><div class="gr">';
    var rowsShown = S.fold ? [Math.floor(diff(gStart, S.sel >= gStart && S.sel <= gEnd ? S.sel : (t0 >= gStart && t0 <= gEnd ? t0 : gStart)) / 7)] : null;
    for (var i = 0; i < weeks * 7; i++) {
      if (rowsShown && Math.floor(i / 7) !== rowsShown[0]) continue;
      var d = add(gStart, i), its = all[d] || [], cols = [];
      its.forEach(function (it) { if (!it.ro && cols.indexOf(it.color) < 0) cols.push(it.color); });
      if (!cols.length && its.length) cols.push("var(--faint)");
      if ((S.cal.todos || []).some(function (t) { return !t.done && t.due === d; }) && cols.length < 3) cols.push("var(--fg)");
      h += '<button type="button" data-day="' + d + '" class="' + (d.slice(0, 7) !== cm ? "out " : "") + (d === t0 ? "today " : "") + (d === S.sel ? "sel" : "") + '">' +
        "<span>" + (+d.slice(8)) + '</span><div class="dots">' + cols.slice(0, 3).map(function (c) { return '<i style="background:' + esc(c) + '"></i>'; }).join("") + "</div></button>";
    }
    h += '</div><button type="button" class="fold" data-a="fold">' + (S.fold ? "展开整月 ⌄" : "收起 ⌃") + "</button></div>";

    var sel = all[S.sel] || [];
    h += '<div class="agday"><b>' + esc(nice(S.sel)) + "</b><span>" + rel(S.sel) + "</span></div><div class=\"list\">";
    h += sel.length ? sel.map(function (it) { return evRow(it, S.sel); }).join("") :
      '<div class="empty">这天没有安排 · <button type="button" class="link" data-a="new" style="color:var(--fg);font-weight:600">加一个</button></div>';
    h += "</div>";

    h += todosHtml();

    var ahead = [];
    for (var j = 0; j < 7; j++) { var dd = add(t0, j); if (dd !== S.sel && all[dd] && all[dd].length) ahead.push(dd); }
    if (ahead.length) {
      h += '<div class="sec"><h2>接下来 7 天</h2></div>';
      ahead.forEach(function (dd) {
        h += '<div class="agday"><span>' + esc(nice(dd)) + "</span><span>" + rel(dd) + '</span></div><div class="list">' +
          all[dd].map(function (it) { return evRow(it, dd); }).join("") + "</div>";
      });
    }
    v.innerHTML = h;
  }
  function bindCal() {
    var v = $("v-cal"), sx = null, sy = 0;
    v.addEventListener("click", function (e) {
      var a = e.target.closest("[data-a]"), dy = e.target.closest("[data-day]"), it = e.target.closest(".ev[data-id]");
      if (a) {
        var act = a.dataset.a;
        if (act === "c-prev" || act === "c-next") {
          S.calMonth = shiftMonth(S.calMonth, act === "c-prev" ? -1 : 1);
          S.sel = S.calMonth === thisMonth() ? today() : S.calMonth + "-01";
          render();
        }
        if (act === "c-today") { S.calMonth = thisMonth(); S.sel = today(); render(); }
        if (act === "c-cats") calCatsSheet();
        if (act === "fold") { S.fold = !S.fold; pref("fold", S.fold ? "1" : null); render(); }
        if (act === "push") pushReminders();
        if (act === "new") evSheet(null, S.sel);
        return;
      }
      if (dy) {
        S.sel = dy.dataset.day;
        if (S.sel.slice(0, 7) !== S.calMonth) S.calMonth = S.sel.slice(0, 7);
        render();
        return;
      }
      if (it) {
        var ev = S.cal.events.filter(function (x) { return x.id === it.dataset.id; })[0];
        if (ev) evSheet(ev, it.dataset.d);
      }
    });
    /* 月历上左右滑换月 */
    v.addEventListener("touchstart", function (e) { sx = e.target.closest(".cal") ? e.touches[0].clientX : null; sy = e.touches[0].clientY; }, { passive: true });
    v.addEventListener("touchend", function (e) {
      if (sx === null) return;
      var dx = e.changedTouches[0].clientX - sx, dyy = e.changedTouches[0].clientY - sy;
      sx = null;
      if (Math.abs(dx) < 60 || Math.abs(dyy) > Math.abs(dx)) return;
      S.calMonth = shiftMonth(S.calMonth, dx < 0 ? 1 : -1);
      S.sel = S.calMonth === thisMonth() ? today() : S.calMonth + "-01";
      render();
    });
  }
  function opt(list, sel) {
    return list.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (String(sel) === x[0] ? " selected" : "") + ">" + esc(x[1]) + "</option>"; }).join("");
  }
  function evSheet(ev, occ) {
    var isNew = !ev, e = ev || { title: "", date: occ || today(), allDay: false, start: nextHour(), finish: "", rep: "none", cat: S.cal.cats[0].id, remind: "", note: "" };
    if (isNew) e.finish = hm(mins(e.start) + 60);
    var cat = e.cat, rep = e.rep || "none";
    var m = sheet(
      "<h3>" + (isNew ? "新日程" : "日程") + closeBtn() + "</h3>" +
      '<input type="text" id="e-title" maxlength="80" value="' + esc(e.title) + '" placeholder="组会、交作业、看牙……" style="font-size:18px;font-weight:600">' +
      '<div class="card" style="margin-top:10px;padding:4px 16px">' +
      '<label class="row" style="justify-content:space-between;min-height:48px"><span>全天</span><span class="sw"><input type="checkbox" id="e-all"' + (e.allDay ? " checked" : "") + "><span></span></span></label>" +
      '<div class="row" style="min-height:52px;border-top:.5px solid var(--line)"><span class="grow">日期</span><input type="date" id="e-date" value="' + esc(e.date) + '" style="width:auto"></div>' +
      '<div id="e-times"' + (e.allDay ? " hidden" : "") + '><div class="row" style="min-height:52px;border-top:.5px solid var(--line)"><span class="grow">开始</span><input type="time" id="e-start" value="' + esc(e.start || "09:00") + '" style="width:auto"></div>' +
      '<div class="row" style="min-height:52px;border-top:.5px solid var(--line)"><span class="grow">结束</span><input type="time" id="e-finish" value="' + esc(e.finish || "10:00") + '" style="width:auto"></div></div>' +
      '<div id="e-endw"' + (e.allDay ? "" : " hidden") + '><div class="row" style="min-height:52px;border-top:.5px solid var(--line)"><span class="grow">到（多天）</span><input type="date" id="e-end" value="' + esc(e.end || "") + '" style="width:auto"></div></div>' +
      "</div>" +
      '<label class="f">分类</label><div class="chips" id="e-cats">' + S.cal.cats.map(function (c) {
        return '<button type="button" class="chip' + (cat === c.id ? " on" : "") + '" data-c="' + esc(c.id) + '"><i style="background:' + esc(c.color) + '"></i>' + esc(c.name) + "</button>";
      }).join("") + "</div>" +
      '<div class="two"><div><label class="f">重复</label><select id="e-rep">' + opt(Object.keys(REPN).map(function (k) { return [k, REPN[k]]; }), rep) + "</select></div>" +
      '<div><label class="f">提醒</label><select id="e-rem">' + opt(REMN, e.remind == null ? "" : e.remind) + "</select></div></div>" +
      '<div id="e-untilw"' + (rep === "none" ? " hidden" : "") + '><label class="f">重复到（可空）</label><input type="date" id="e-until" value="' + esc(e.until || "") + '"></div>' +
      '<label class="f">备注</label><textarea id="e-note" rows="2" maxlength="2000">' + esc(e.note || "") + "</textarea>" +
      '<div class="acts">' + (isNew ? "" : '<button type="button" class="btn danger" data-x="del">删除</button>') +
      '<button type="button" class="btn pri" data-x="save">' + (isNew ? "加上" : "保存") + "</button></div>");
    function q(id) { return m.querySelector("#" + id); }
    q("e-all").addEventListener("change", function () { q("e-times").hidden = this.checked; q("e-endw").hidden = !this.checked; });
    q("e-rep").addEventListener("change", function () { q("e-untilw").hidden = this.value === "none"; });
    q("e-start").addEventListener("change", function () {
      var dur = mins(e.finish || "10:00") - mins(e.start || "09:00");
      if (dur <= 0) dur = 60;
      q("e-finish").value = hm(mins(this.value) + dur);
      e.start = this.value; e.finish = q("e-finish").value;
    });
    m.addEventListener("click", function (evt) {
      var c = evt.target.closest("[data-c]"), x = evt.target.closest("[data-x]");
      if (c) { cat = c.dataset.c; [].forEach.call(q("e-cats").children, function (b) { b.classList.toggle("on", b.dataset.c === cat); }); }
      if (!x) return;
      if (x.dataset.x === "close") { close(m); return; }
      if (x.dataset.x === "del") {
        close(m);
        if (ev.rep && ev.rep !== "none") delSheet(ev, occ); else delEvent(ev);
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
      close(m);
      S.sel = date; S.calMonth = date.slice(0, 7);
      changed("calendar");
      toast(ev ? "改好了" : "加上了：" + nice(date), "", t.remind !== undefined ? { label: "推到提醒事项", run: pushReminders } : null, 5000);
    });
    if (isNew) setTimeout(function () { q("e-title").focus(); }, 60);
  }
  function nextHour() { var d = new Date(); return hm(Math.min(23, d.getHours() + 1) * 60); }
  function delSheet(ev, occ) {
    var m = sheet("<h3>删除重复日程" + closeBtn() + "</h3><p style=\"margin:4px 2px\">「" + esc(ev.title) + "」是" + esc(REPN[ev.rep]) + "重复的。</p>" +
      '<div class="acts" style="flex-direction:column"><button type="button" class="btn" data-x="one">只删 ' + esc(nice(occ)) + " 这一次</button>" +
      '<button type="button" class="btn danger" data-x="from">删掉这次和以后的</button>' +
      '<button type="button" class="btn danger" data-x="all">删除整个系列</button></div>');
    m.addEventListener("click", function (e) {
      var x = e.target.closest("[data-x]");
      if (!x) return;
      close(m);
      if (x.dataset.x === "one") { ev.ex = (ev.ex || []).concat([occ]); changed("calendar"); toast("这一次删掉了"); }
      if (x.dataset.x === "from") {
        if (occ <= ev.date) { delEvent(ev); return; }
        var old = ev.until;
        ev.until = add(occ, -1);
        changed("calendar");
        toast("从 " + nice(occ) + " 起不再重复", "", { label: "撤销", run: function () { ev.until = old; changed("calendar"); } }, 5000);
      }
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
  /* 日程分类：显示/隐藏、改名、换颜色、删除（里面的日程归到你选的分类）、新建 */
  function calCatsSheet() {
    function body() {
      return "<h3>日程分类" + closeBtn() + '</h3><div class="list">' + S.cal.cats.map(function (c) {
        var n = S.cal.events.filter(function (e) { return e.cat === c.id; }).length;
        return '<div class="cell tap" data-cc="' + esc(c.id) + '"><span class="dot" style="width:14px;height:14px;border-radius:50%;background:' + esc(c.color) + ';flex:none"></span>' +
          '<div class="grow"><div>' + esc(c.name) + '</div><div class="sub">' + n + " 个日程</div></div>" +
          '<span class="sw" data-noopen="1"><input type="checkbox" data-vis="' + esc(c.id) + '"' + (S.cal.hide.indexOf(c.id) < 0 ? " checked" : "") + "><span></span></span></div>";
      }).join("") + "</div>" +
        '<button type="button" class="btn wide" data-x="add" style="margin-top:10px;background:var(--card)">＋ 新分类</button>' +
        '<div class="card" style="margin-top:10px"><label class="row" style="justify-content:space-between"><span>显示预算里的固定收支<div class="dim small">每月付款、进账的日子</div></span>' +
        '<span class="sw"><input type="checkbox" id="ov-bills"' + (S.cal.show.bills !== false ? " checked" : "") + "><span></span></span></label></div>" +
        '<p class="dim small" style="margin:10px 4px 0">开关控制在日程里显不显示；点名字改名、换颜色或删除。</p>';
    }
    var m = sheet(body());
    var sh = m.firstChild;
    function redraw() { sh.innerHTML = '<div class="grab"></div>' + body(); }
    m.addEventListener("change", function (e) {
      var vis = e.target.dataset.vis;
      if (vis) {
        S.cal.hide = S.cal.hide.filter(function (x) { return x !== vis; });
        if (!e.target.checked) S.cal.hide.push(vis);
        changed("calendar");
      }
      if (e.target.id === "ov-bills") { S.cal.show.bills = e.target.checked; changed("calendar"); }
    });
    m.addEventListener("click", function (e) {
      var x = e.target.closest("[data-x]"), cc = e.target.closest("[data-cc]");
      if (e.target.closest("[data-noopen]")) return;
      if (x && x.dataset.x === "close") { close(m); return; }
      if (x && x.dataset.x === "add") { close(m); calCatEdit(null); return; }
      if (cc) { close(m); calCatEdit(S.cal.cats.filter(function (c) { return c.id === cc.dataset.cc; })[0]); }
    });
  }
  function calCatEdit(c) {
    var isNew = !c, used = S.cal.cats.map(function (x) { return x.color; });
    var color = c ? c.color : (PALETTE.filter(function (p) { return used.indexOf(p) < 0; })[0] || PALETTE[S.cal.cats.length % PALETTE.length]);
    var rest = S.cal.cats.filter(function (x) { return x !== c; });
    var n = c ? S.cal.events.filter(function (e) { return e.cat === c.id; }).length : 0;
    var m = sheet("<h3>" + (isNew ? "新分类" : "分类") + closeBtn() + "</h3>" +
      '<input type="text" id="cc-name" maxlength="12" value="' + esc(c ? c.name : "") + '" placeholder="名字">' +
      '<label class="f">颜色</label><div class="chips" id="cc-col">' + PALETTE.map(function (p) {
        return '<button type="button" class="chip' + (p === color ? " on" : "") + '" data-col="' + p + '" style="padding:6px"><i style="width:22px;height:22px;background:' + p + '"></i></button>';
      }).join("") + "</div>" +
      (!isNew && rest.length ? '<label class="f">删除时，里面的 ' + n + ' 个日程归到</label><select id="cc-to">' +
        rest.map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(r.name) + "</option>"; }).join("") + "</select>" : "") +
      '<div class="acts">' + (!isNew && rest.length ? '<button type="button" class="btn danger" data-x="del">删除</button>' : "") +
      '<button type="button" class="btn pri" data-x="save">' + (isNew ? "加上" : "保存") + "</button></div>");
    var q = function (id) { return m.querySelector("#" + id); };
    if (isNew) setTimeout(function () { q("cc-name").focus(); }, 60);
    m.addEventListener("click", function (e) {
      var col = e.target.closest("[data-col]"), x = e.target.closest("[data-x]");
      if (col) { color = col.dataset.col; [].forEach.call(q("cc-col").children, function (b) { b.classList.toggle("on", b === col); }); return; }
      if (!x) return;
      if (x.dataset.x === "close") { close(m); calCatsSheet(); return; }
      if (x.dataset.x === "del") {
        var to = q("cc-to").value, toName = rest.filter(function (r) { return r.id === to; })[0].name;
        ask("删掉分类「" + c.name + "」？里面的 " + n + " 个日程归到「" + toName + "」。", "删除", true).then(function (y) {
          if (!y) return;
          S.cal.events.forEach(function (ev) { if (ev.cat === c.id) ev.cat = to; });
          S.cal.cats = rest;
          S.cal.hide = S.cal.hide.filter(function (h) { return h !== c.id; });
          close(m); changed("calendar"); calCatsSheet();
        });
        return;
      }
      var name = q("cc-name").value.trim();
      if (!name) { toast("写个名字", "bad"); return; }
      if (S.cal.cats.some(function (o) { return o !== c && o.name === name; })) { toast("已经有这个分类了", "bad"); return; }
      if (isNew) S.cal.cats.push({ id: "c" + uid(), name: name.slice(0, 12), color: color });
      else { c.name = name.slice(0, 12); c.color = color; }
      close(m); changed("calendar"); calCatsSheet();
    });
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
  function swRow(id, label, sub, on) {
    return '<label class="cell"><div class="grow"><div>' + label + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>" +
      '<span class="sw"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + "><span></span></span></label>";
  }
  function renderSet() {
    var base = location.origin + "/app/";
    var h = '<div class="sec" style="margin-top:6px"><h2>同步</h2></div><div class="list">' +
      '<div class="cell"><div class="grow">账本</div><span class="dim small">' + esc(syncState.budget || "…") + "</span></div>" +
      '<div class="cell"><div class="grow">日程</div><span class="dim small">' + esc(syncState.calendar || "…") + "</span></div>" +
      '<div class="cell tap" data-a="now"><div class="grow">立即同步</div><span class="chev">›</span></div>' +
      '<div class="cell tap" data-a="setup"><div class="grow">令牌 / 口令</div><span class="chev">›</span></div></div>';
    h += '<div class="sec"><h2>记账</h2></div><div class="list">' +
      swRow("autosave", "截图认出金额就直接记", "不弹确认，记完顶上有「改」可以修", pref("autosave") === "1") +
      '<label class="cell tap"><div class="grow"><div>导入支付宝 / 微信账单</div><div class="sub">csv 或 xlsx；记过的自动对上，不重复</div></div><span class="chev">›</span>' +
      '<input type="file" id="billfile" accept=".csv,.xlsx,text/csv" hidden></label>' +
      '<div class="cell tap" data-a="csv-month"><div class="grow"><div>导出本月流水</div><div class="sub">CSV，和电脑上导出的一样</div></div><span class="chev">›</span></div>' +
      '<div class="cell tap" data-a="csv-all"><div class="grow">导出全部流水</div><span class="chev">›</span></div>' +
      '<div class="cell"><div class="grow">货币符号</div><input type="text" id="currency" maxlength="4" value="' + esc(cur()) + '" style="width:70px;text-align:center;min-height:36px;padding:6px"></div></div>';
    h += '<div class="sec"><h2>日程</h2></div><div class="list">' +
      '<div class="cell tap" data-a="push"><div class="grow"><div>把提醒推到「提醒事项」</div><div class="sub">接下来 30 天带提醒的日程，要先建好快捷指令②</div></div><span class="chev">›</span></div>' +
      '<div class="cell tap" data-a="ccats"><div class="grow">日程分类</div><span class="chev">›</span></div></div>';
    h += '<div class="sec"><h2>快捷指令</h2></div><div class="guide">' +
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
      "<li>添加 <span class=\"k\">从输入中获取词典</span>（输入：快捷指令输入）。</li>" +
      "<li>添加 <span class=\"k\">查找提醒事项</span>：过滤条件「列表 是 日程」且「已完成 不是」，然后添加 <span class=\"k\">移除提醒事项</span>（输入：上一步找到的）。先清掉旧的再整批重写，不会重复。</li>" +
      "<li>添加 <span class=\"k\">获取词典值</span>：键 <span class=\"k\">items</span>（词典：第 3 步的词典）。</li>" +
      "<li>添加 <span class=\"k\">重复每一项</span>（输入：上一步的值），在循环里：<br>" +
      "· <span class=\"k\">获取词典值</span> 键 <span class=\"k\">at</span>（词典：重复项目），再接 <span class=\"k\">从输入中获取日期</span>；<br>" +
      "· <span class=\"k\">获取词典值</span> 键 <span class=\"k\">title</span>，和键 <span class=\"k\">notes</span>；<br>" +
      "· <span class=\"k\">添加新提醒事项</span>：标题选 title，列表选「日程」，展开后「提醒我」开、日期选上面得到的日期，备注选 notes。</li>" +
      "<li>回到这里，日程页顶上出现「推送」时点一下就行。</li></ol>" +
      '<p class="dim small">提醒事项到点会在锁屏弹出，Apple Watch 也会震。电脑上加的日程，下次打开手机 App 点「推送」就会补上。</p></details>' +
      "<details><summary>③ Apple Pay 刷卡自动记（可选）</summary><ol>" +
      "<li>快捷指令 → 自动化 → 新建 → <span class=\"k\">交易</span>，选你的卡，选「立即运行」。</li>" +
      "<li>添加 <span class=\"k\">文本</span>，填下面这串，在 amt= 后插入「快捷指令输入」的「金额」，note= 后插入「商家」：</li></ol>" +
      '<div class="copy"><input type="text" readonly value="' + esc(base + "#add?src=Apple%20Pay&amt=&note=") + '"><button class="btn sm" type="button" data-copy="' + esc(base + "#add?src=Apple%20Pay&amt=&note=") + '">复制</button></div>' +
      "<ol start=\"3\"><li>添加 <span class=\"k\">打开 URL</span>。</li></ol>" +
      '<p class="dim small">支付宝和微信的通知 iOS 不让快捷指令读，所以那两个只能靠①截图和月底导入账单。</p></details></div>';
    h += '<div class="sec"><h2>这台设备</h2></div><div class="list">' +
      '<div class="cell"><div class="grow"><div>加到主屏幕</div><div class="sub">Safari 底部「分享」→「添加到主屏幕」</div></div></div>' +
      '<div class="cell tap" data-a="forget"><div class="grow" style="color:var(--bad)">忘掉这台设备</div></div></div>' +
      '<p class="dim small" style="margin:14px 6px">数据格式和电脑上的预算页、日程页一样，两边随便改，联网后自动合并。同一条两边都改了的话，以本机为准。</p>';
    $("v-set").innerHTML = h;
  }
  function csvCell(v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function exportCsv(all) {
    var rows = (all ? S.budget.tx.slice() : monthTx(S.month)).sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    if (!rows.length) { toast("没有流水可以导出", "bad"); return; }
    var out = ["日期,类型,分类,金额,备注"];
    rows.forEach(function (t) {
      out.push([t.d, t.kind === "in" ? "收入" : "支出", t.kind === "in" ? "" : catName(t.cat), plain(t.amt), t.note].map(csvCell).join(","));
    });
    var name = "budget-" + (all ? "all" : S.month) + ".csv", text = "\ufeff" + out.join("\r\n") + "\r\n";
    var file = null;
    try { file = new File([text], name, { type: "text/csv" }); } catch (e) {}
    /* iPhone 上走系统分享面板：存到「文件」或者发给自己 */
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(function () {});
      return;
    }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
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
      var act = a.dataset.a;
      if (act === "now") { LabSync.syncNow("budget"); LabSync.syncNow("calendar"); toast("同步中…", "", null, 1200); }
      if (act === "setup") LabSync.dialog().then(function (ok) { if (ok === "forgot") location.reload(); });
      if (act === "csv-month") exportCsv(false);
      if (act === "csv-all") exportCsv(true);
      if (act === "push") pushReminders();
      if (act === "ccats") calCatsSheet();
      if (act === "forget") {
        ask("清除这台设备上的令牌、密钥和离线副本？仓库里的数据不受影响。", "清除", true).then(function (y) {
          if (y) LabSync.forget().then(function () { location.reload(); });
        });
      }
    });
    v.addEventListener("change", function (e) {
      if (e.target.id === "autosave") pref("autosave", e.target.checked ? "1" : null);
      if (e.target.id === "billfile" && e.target.files[0]) { importBill(e.target.files[0]); e.target.value = ""; }
      if (e.target.id === "currency") {
        var c = e.target.value.trim().slice(0, 4) || "¥";
        if (c !== S.budget.currency) { S.budget.currency = c; changed("budget"); toast("货币符号改成 " + c); }
      }
    });
  }

  function importBill(file) {
    Bills.readFile(file).then(function (r) {
      return LabSync.syncNow("budget").catch(function () {}).then(function () { return r; });
    }).then(function (r) {
      if (!r.rows) { toast("认不出这是支付宝还是微信的账单", "bad", null, 4000); return; }
      var rec = Bills.reconcile(r.rows, S.budget.tx), lrn = learned();
      var m = sheet("<h3>导入" + esc(r.src) + "账单" + closeBtn() + "</h3>" +
        '<div class="list"><div class="cell"><div class="grow">账单里</div><span class="num">' + r.rows.length + " 笔</span></div>" +
        '<div class="cell"><div class="grow">新增</div><b class="num">' + rec.add.length + "</b></div>" +
        '<div class="cell"><div class="grow">和已记的对上</div><span class="num">' + rec.match.length + "</span></div>" +
        '<div class="cell"><div class="grow">重复跳过</div><span class="num">' + rec.dup + "</span></div>" +
        (r.skipped ? '<div class="cell"><div class="grow">不计收支 / 已关闭 / 已退款</div><span class="num">' + r.skipped + "</span></div>" : "") + "</div>" +
        '<p class="dim small" style="margin:10px 4px 0">新增的按商家猜分类，之后可以在流水里点开改。</p>' +
        '<div class="acts"><button type="button" class="btn pri" data-x="ok">导入</button></div>');
      m.addEventListener("click", function (e) {
        var x = e.target.closest("[data-x]");
        if (!x) return;
        close(m);
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
    if (h === "plan") { go("plan"); clearHash(); return; }
    if (h === "add") { clearHash(); go("money"); txSheet({}); return; }
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
      txSheet(t, { title: t.src ? "来自 " + t.src : "记一笔" });
    }
  }
  function clearHash() { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { location.hash = ""; } }
  function fromOcr(text) {
    go("money");
    var r = Bills.parseOcr(text);
    var t = { amt: isNaN(r.amt) ? 0 : r.amt, kind: r.kind, note: r.merchant || r.goods || "", src: r.src, d: r.d || today() };
    t.cat = t.kind === "in" ? "" : Bills.guessCat([r.merchant, r.goods].join(" "), S.budget.categories, learned());
    if (!t.amt) { txSheet(t, { title: "没认出金额", hint: "截图里没找到像金额的数字，按一下键盘填上。" }); return; }
    /* 同一天、同金额、几小时内记过的（比如重复截了两次）先提醒一下 */
    var dupe = S.budget.tx.filter(function (x) { return x.d === t.d && x.amt === t.amt && x.kind === t.kind && Date.now() - (x.ts || 0) < 6 * 3600e3; })[0];
    if (pref("autosave") === "1" && !dupe) return autoSave(t);
    txSheet(t, { title: "截图记账" + (r.src ? " · " + r.src : ""),
                 hint: dupe ? "今天已经记过一笔同样金额的（" + (dupe.note || "") + "），确认不是重复再记。" : "" });
  }
  function autoSave(t) {
    var row = { id: uid(), d: t.d, amt: t.amt, kind: t.kind, cat: t.cat || "", note: t.note.slice(0, 60), ts: Date.now() };
    if (t.src) row.src = t.src;
    S.budget.tx.push(row);
    changed("budget");
    toast("记了 " + fmt(row.amt) + " " + (row.note || ""), "", { label: "改", run: function () { txSheet(row); } }, 6000);
  }

  /* ------------------------------------------------------------ 框架 */
  /* ------------------------------------------------------------ 统计页 */
  function pctTxt(a, b) { if (!b) return a ? "新增" : "—"; var d = Math.round((a - b) / b * 100); return (d > 0 ? "+" : "") + d + "%"; }
  function donutSvg(parts, total) {
    var R = 70, r = 46, cx = 90, cy = 90, a0 = -Math.PI / 2, s = '<svg viewBox="0 0 180 180" class="donut" role="img" aria-label="分类占比">';
    if (!total) return s + '<circle cx="90" cy="90" r="58" fill="none" stroke="var(--press)" stroke-width="24"></circle></svg>';
    parts.forEach(function (p) {
      var f = p.v / total; if (f <= 0) return;
      if (f >= 0.9999) { s += '<circle cx="90" cy="90" r="58" fill="none" stroke="' + p.col + '" stroke-width="24"></circle>'; return; }
      var a1 = a0 + f * Math.PI * 2, big = f > .5 ? 1 : 0;
      function P(rr, a) { return (cx + rr * Math.cos(a)).toFixed(2) + " " + (cy + rr * Math.sin(a)).toFixed(2); }
      s += '<path d="M' + P(R, a0) + " A" + R + " " + R + " 0 " + big + " 1 " + P(R, a1) + " L" + P(r, a1) + " A" + r + " " + r + " 0 " + big + " 0 " + P(r, a0) +
        'Z" fill="' + p.col + '" stroke="var(--card)" stroke-width="1.5"></path>';
      a0 = a1;
    });
    return s + "</svg>";
  }
  function renderStats() {
    var v = $("v-stats"), mo = S.month, lm = shiftMonth(mo, -1);
    var cur0 = monthTx(mo), sp = spentBy(mo), spl = spentBy(lm), k = calc(mo);
    var outs = cur0.filter(function (t) { return t.kind !== "in"; });
    var dim = daysIn(mo), upto = mo === thisMonth() ? new Date().getDate() : mo < thisMonth() ? dim : 0;
    var h = monSwitch(mo, "s");
    /* 概览 */
    var lastSame = 0;
    if (mo === thisMonth()) monthTx(lm).forEach(function (t) { if (t.kind !== "in" && +t.d.slice(8) <= upto) lastSame += t.amt; });
    h += '<div class="tiles">' +
      '<div class="tile"><small>支出</small><div class="num">' + esc(fmt(sp.out)) + '</div><div class="s">' + outs.length + " 笔</div></div>" +
      '<div class="tile"><small>日均</small><div class="num">' + esc(fmt(upto ? Math.round(sp.out / upto) : 0)) + '</div><div class="s">' + (upto ? "按 " + upto + " 天算" : "&nbsp;") + "</div></div>" +
      '<div class="tile"><small>' + (mo === thisMonth() ? "比上月同期" : "比上月") + '</small><div class="num ' + ((mo === thisMonth() ? lastSame : spl.out) && sp.out > (mo === thisMonth() ? lastSame : spl.out) ? "neg" : "") + '">' +
        esc(pctTxt(sp.out, mo === thisMonth() ? lastSame : spl.out)) + '</div><div class="s">上月' + (mo === thisMonth() ? "同期 " : " ") + esc(fmt(mo === thisMonth() ? lastSame : spl.out)) + "</div></div>" +
      '<div class="tile ' + (sp.income - sp.out < 0 ? "bad" : sp.income ? "ok" : "") + '"><small>结余率</small><div class="num">' + (sp.income ? Math.round((sp.income - sp.out) / sp.income * 100) + "%" : "—") +
        '</div><div class="s">' + (sp.income ? "收入 " + esc(fmt(sp.income)) : "这个月没记收入") + "</div></div></div>";
    if (!outs.length) { v.innerHTML = h + '<div class="list" style="margin-top:12px"><div class="empty">这个月还没有支出可统计</div></div>'; return; }
    /* 分类占比 */
    var parts = Object.keys(sp.cat).map(function (id) { return { id: id, v: sp.cat[id], last: spl.cat[id] || 0, col: catColor(id), name: id ? catName(id) : "未分类" }; })
      .sort(function (a, b) { return b.v - a.v; });
    h += '<div class="sec"><h2>花在哪</h2></div><div class="card"><div class="donutw">' + donutSvg(parts, sp.out) +
      '<div class="dc"><small>共</small><b class="num">' + esc(short(sp.out)) + "</b></div></div>";
    h += '<div class="slist">' + parts.map(function (p) {
      var d = p.v - p.last;
      return '<div class="srow tap" data-scat="' + esc(p.id) + '"><i style="background:' + p.col + '"></i><span class="grow">' + esc(p.name) +
        ' <span class="dim small">' + Math.round(p.v / sp.out * 100) + "%</span></span>" +
        '<span class="dim small num">' + (p.last ? (d > 0 ? "↑" : d < 0 ? "↓" : "") + esc(fmt(Math.abs(d))) : "上月没有") + "</span>" +
        '<b class="num">' + esc(fmt(p.v)) + "</b></div>";
    }).join("") + "</div></div>";
    /* 每天 */
    var days = [], max = 1, i;
    for (i = 1; i <= dim; i++) days.push(0);
    outs.forEach(function (t) { days[+t.d.slice(8) - 1] += t.amt; });
    days.forEach(function (x) { max = Math.max(max, x); });
    var avg = upto ? sp.out / upto : 0, W = 620, H = 200, top = 14, bot = 26, ch = H - top - bot, bw = W / dim;
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" class="daily" role="img" aria-label="每天支出">';
    days.forEach(function (x, j) {
      var hh = x / max * ch, d = mo + "-" + p2(j + 1), fut = mo === thisMonth() && j + 1 > upto;
      svg += '<rect data-sday="' + d + '" x="' + (j * bw + bw * .18) + '" y="' + (top + ch - Math.max(hh, x ? 3 : 0)) + '" width="' + (bw * .64) + '" height="' + Math.max(hh, x ? 3 : 0) +
        '" rx="3" class="' + (x > avg * 1.8 && avg ? "hi" : "") + (d === S.sday ? " on" : "") + '"></rect>' +
        '<rect data-sday="' + d + '" x="' + (j * bw) + '" y="0" width="' + bw + '" height="' + H + '" fill="transparent"></rect>';
      if (j === 0 || (j + 1) % 5 === 0) svg += '<text x="' + (j * bw + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle"' + (fut ? ' opacity=".5"' : "") + ">" + (j + 1) + "</text>";
    });
    if (avg) { var ay = top + ch - avg / max * ch; svg += '<line class="avg" x1="0" x2="' + W + '" y1="' + ay + '" y2="' + ay + '"></line>'; }
    svg += '<line class="ax" x1="0" x2="' + W + '" y1="' + (top + ch) + '" y2="' + (top + ch) + '"></line></svg>';
    var sd = S.sday && S.sday.slice(0, 7) === mo ? S.sday : "";
    h += '<div class="sec"><h2>每天</h2><span class="r">虚线是日均</span></div><div class="card trend">' + svg +
      '<div class="hint" id="sdayt">' + (sd ? esc(nice(sd)) + " 花了 " + esc(fmt(days[+sd.slice(8) - 1])) + ' · <button type="button" class="link" data-a="s-goday" style="color:var(--fg);font-weight:600;padding:0">看流水 ›</button>' : "点柱子看那天") + "</div></div>";
    /* 星期几 */
    var wk = [0, 0, 0, 0, 0, 0, 0], wn = [0, 0, 0, 0, 0, 0, 0];
    for (i = 1; i <= upto; i++) wn[dow(mo + "-" + p2(i))]++;
    outs.forEach(function (t) { wk[dow(t.d)] += t.amt; });
    var wa = wk.map(function (x, j) { return wn[j] ? x / wn[j] : 0; }), wmax = Math.max.apply(null, wa.concat([1]));
    h += '<div class="sec"><h2>星期几花得多</h2><span class="r">每天平均</span></div><div class="card"><div class="wkb">' + wa.map(function (x, j) {
      return '<div><span class="num">' + esc(short(x)) + '</span><i style="height:' + Math.max(2, x / wmax * 70).toFixed(0) + 'px"' + (x === wmax && x ? ' class="on"' : "") + "></i><small>" + WD[j] + "</small></div>";
    }).join("") + "</div></div>";
    /* 最大几笔 / 常去 */
    var big = outs.slice().sort(function (a, b) { return b.amt - a.amt; }).slice(0, 5);
    h += '<div class="sec"><h2>最大的 5 笔</h2></div><div class="list">' + big.map(function (t) {
      var name = catName(t.cat);
      return '<div class="cell tap" data-stx="' + esc(t.id) + '">' + dot(t.cat, name) + '<div class="grow"><div>' + esc(t.note || name) + '</div><div class="sub">' + esc(nice(t.d)) + " · " + esc(name) + "</div></div>" +
        '<span class="num">' + esc(fmt(-t.amt)) + "</span></div>";
    }).join("") + "</div>";
    var by = {};
    outs.forEach(function (t) { var n = (t.note || "").trim(); if (!n) return; by[n] = by[n] || { n: n, c: 0, s: 0, cat: t.cat }; by[n].c++; by[n].s += t.amt; });
    var top5 = Object.keys(by).map(function (n) { return by[n]; }).filter(function (x) { return x.c > 1; }).sort(function (a, b) { return b.s - a.s; }).slice(0, 5);
    if (top5.length) {
      h += '<div class="sec"><h2>常花的地方</h2><span class="r">按备注</span></div><div class="list">' + top5.map(function (x) {
        return '<div class="cell tap" data-snote="' + esc(x.n) + '">' + dot(x.cat, catName(x.cat)) + '<div class="grow"><div>' + esc(x.n) + '</div><div class="sub">' + x.c + " 次 · 平均 " + esc(fmt(Math.round(x.s / x.c))) + "</div></div>" +
          '<span class="num">' + esc(fmt(x.s)) + "</span></div>";
      }).join("") + "</div>";
    }
    h += '<div class="sec"><h2>近六个月</h2></div><div class="card trend">' + trendSvg(mo) +
      '<div class="legend"><span><i style="background:var(--acc)"></i>支出</span><span><i style="background:var(--ok);opacity:.35"></i>收入</span></div></div>';
    v.innerHTML = h;
  }
  function bindStats() {
    $("v-stats").addEventListener("click", function (e) {
      var a = e.target.closest("[data-a]"), sc = e.target.closest("[data-scat]"), st = e.target.closest("[data-stx]"),
          sn = e.target.closest("[data-snote]"), sd = e.target.closest("[data-sday]");
      if (a) {
        var act = a.dataset.a;
        if (act === "s-prev") { S.month = shiftMonth(S.month, -1); render(); }
        if (act === "s-next") { S.month = shiftMonth(S.month, 1); render(); }
        if (act === "s-now") { S.month = thisMonth(); render(); }
        if (act === "s-goday") { S.filter = null; S.q = ""; S.searching = false; var jd = S.sday; go("money"); setTimeout(function () { var el = $("day-" + jd); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70, behavior: "smooth" }); }, 60); }
        return;
      }
      if (sc) { S.filter = sc.dataset.scat; S.q = ""; S.searching = false; go("money"); return; }
      if (sn) { S.filter = null; S.q = sn.dataset.snote; S.searching = true; go("money"); return; }
      if (st) { var t = S.budget.tx.filter(function (x) { return x.id === st.dataset.stx; })[0]; if (t) txSheet(t); return; }
      if (sd) { S.sday = S.sday === sd.dataset.sday ? "" : sd.dataset.sday; haptic(1); renderStats(); }
    });
  }

  /* ------------------------------------------------------------ 存钱目标（存在账本 goals 里，电脑页不认识也会原样保留） */
  function goalSaved(g) { return (g.log || []).reduce(function (s, x) { return s + x.amt; }, 0); }
  function goalsHtml() {
    var gs = S.budget.goals || [];
    var h = '<div class="sec"><h2>存钱目标</h2><button type="button" class="r" data-a="addgoal">＋ 目标</button></div><div class="list">';
    if (!gs.length) h += '<div class="empty">想买的东西、旅行、应急金……定个数，一点点存</div>';
    gs.forEach(function (g) {
      var sv = goalSaved(g), pct = g.target ? Math.min(100, sv / g.target * 100) : 0, sub = [];
      if (sv >= g.target) sub.push("✓ 达成了");
      else {
        sub.push("还差 " + fmt(g.target - sv));
        if (g.due && g.due >= today()) {
          var mleft = Math.max(1, (+g.due.slice(0, 4) - +today().slice(0, 4)) * 12 + (+g.due.slice(5, 7) - +today().slice(5, 7)) + 1);
          sub.push("每月存 " + fmt(Math.ceil((g.target - sv) / mleft / 100) * 100));
        } else if (g.due) sub.push('<span class="neg">已过期限</span>');
      }
      h += '<div class="cat tap" data-goal="' + esc(g.id) + '"><span class="dot" style="background:' + (sv >= g.target ? "var(--ok)" : "var(--acc)") + ';color:var(--acc-fg)">' + esc(initial(g.name)) + "</span>" +
        '<div class="mid"><div class="t"><span class="nm">' + esc(g.name) + '</span><span class="num">' + esc(fmt(sv)) + ' <span class="dim">/ ' + esc(fmt(g.target)) + "</span></span></div>" +
        '<div class="bar"><i style="width:' + pct.toFixed(1) + "%;background:" + (sv >= g.target ? "var(--ok)" : "var(--acc)") + '"></i></div>' +
        '<div class="meta"><span>' + sub.join(" · ") + "</span><span>" + (g.due ? (+g.due.slice(0, 4)) + " 年 " + (+g.due.slice(5, 7)) + " 月前" : "") + "</span></div></div>" +
        '<button type="button" class="btn sm" data-gadd="' + esc(g.id) + '">存</button></div>';
    });
    return h + "</div>";
  }
  function goalSheet(g) {
    var isNew = !g, e = g || { name: "", target: 0, due: "" };
    var m = sheet("<h3>" + (isNew ? "新的存钱目标" : "存钱目标") + closeBtn() + "</h3>" +
      '<label class="f">存来干嘛</label><input type="text" id="g-name" maxlength="30" placeholder="新电脑、毕业旅行、应急金……" value="' + esc(e.name) + '">' +
      '<div class="two"><div><label class="f">目标金额</label><input type="text" id="g-amt" inputmode="decimal" class="num" value="' + (e.target ? plain(e.target) : "") + '"></div>' +
      '<div><label class="f">期限（可不填）</label><input type="date" id="g-due" value="' + esc(e.due || "") + '"></div></div>' +
      (isNew ? "" : '<label class="f">记录</label><div class="list">' + ((g.log || []).slice().reverse().slice(0, 12).map(function (x) {
        return '<div class="cell"><div class="grow"><div>' + esc(nice(x.d)) + "</div></div><span class=\"num " + (x.amt > 0 ? "pos" : "neg") + '">' + esc(fmt(x.amt, true)) + "</span></div>";
      }).join("") || '<div class="empty">还没存过</div>') + "</div>") +
      '<div class="acts">' + (isNew ? "" : '<button type="button" class="btn danger" data-x="del">删除</button>') +
      '<button type="button" class="btn pri" data-x="save">' + (isNew ? "开始存" : "保存") + "</button></div>");
    var q = function (id) { return m.querySelector("#" + id); };
    if (isNew) setTimeout(function () { q("g-name").focus(); }, 60);
    m.addEventListener("click", function (ev) {
      var x = ev.target.closest("[data-x]");
      if (!x) return;
      if (x.dataset.x === "close") { close(m); return; }
      if (x.dataset.x === "del") {
        ask("删掉目标「" + g.name + "」？存的记录一起删，流水不动。", "删除", true).then(function (y) {
          if (!y) return;
          S.budget.goals.splice(S.budget.goals.indexOf(g), 1); close(m); changed("budget");
        });
        return;
      }
      var name = q("g-name").value.trim(), amt = parseAmt(q("g-amt").value), due = q("g-due").value;
      if (!name) { toast("写个名字", "bad"); return; }
      if (!amt || isNaN(amt) || amt <= 0) { toast("目标金额看不懂", "bad"); return; }
      var row = g || { id: "g" + uid(), log: [], ts: Date.now() };
      row.name = name.slice(0, 30); row.target = amt; row.due = validDate(due) ? due : "";
      if (isNew) S.budget.goals.push(row);
      close(m); changed("budget");
      toast(isNew ? "目标「" + row.name + "」开始了" : "改好了");
    });
  }
  function goalMoveSheet(g) {
    var dir = 1, expr = "", alsoTx = pref("goaltx") !== "0";
    var save = S.budget.categories.filter(function (c) { return c.id === "save"; })[0] || S.budget.categories.filter(function (c) { return c.roll; })[0];
    var m = sheet("<h3>" + esc(g.name) + closeBtn() + "</h3>" +
      '<div class="seg" id="gm-dir"><button type="button" data-k="1" class="on">存进去</button><button type="button" data-k="-1">取出来</button></div>' +
      '<label class="f">金额</label><input type="text" id="gm-amt" inputmode="decimal" class="num" placeholder="0">' +
      '<div class="chips" style="margin-top:10px">' + [50, 100, 200, 500, 1000].map(function (n) { return '<button type="button" class="chip" data-q="' + n + '">' + cur() + n + "</button>"; }).join("") + "</div>" +
      (save ? '<div class="cell" style="padding:14px 2px 0;min-height:0"><div class="grow"><div>同时记一笔「' + esc(save.name) + '」支出</div><div class="sub">这样本月预算也会扣掉，取出时不记</div></div>' +
        '<label class="sw"><input type="checkbox" id="gm-tx"' + (alsoTx ? " checked" : "") + "><span></span></label></div>" : "") +
      '<div class="acts"><button type="button" class="btn pri" data-x="save">确定</button></div>');
    var q = function (id) { return m.querySelector("#" + id); };
    setTimeout(function () { q("gm-amt").focus(); }, 60);
    m.addEventListener("click", function (ev) {
      var k = ev.target.closest("[data-k]"), qq = ev.target.closest("[data-q]"), x = ev.target.closest("[data-x]");
      if (k) { dir = +k.dataset.k; [].forEach.call(q("gm-dir").children, function (b) { b.classList.toggle("on", b === k); }); return; }
      if (qq) { q("gm-amt").value = qq.dataset.q; return; }
      if (!x) return;
      if (x.dataset.x === "close") { close(m); return; }
      var amt = parseAmt(q("gm-amt").value);
      if (!amt || isNaN(amt) || amt <= 0) { toast("金额看不懂", "bad"); return; }
      if (dir < 0 && amt > goalSaved(g)) { toast("没存这么多", "bad"); return; }
      var d = today(), tx = save && q("gm-tx") && q("gm-tx").checked && dir > 0;
      if (save && q("gm-tx")) pref("goaltx", q("gm-tx").checked ? null : "0");
      g.log = g.log || [];
      g.log.push({ id: uid(), d: d, amt: dir * amt });
      if (tx) S.budget.tx.push({ id: uid(), d: d, amt: amt, kind: "out", cat: save.id, note: "存：" + g.name, ts: Date.now() });
      close(m); changed("budget");
      var sv = goalSaved(g);
      toast(sv >= g.target && dir > 0 ? "🎉 「" + g.name + "」存够了！" : (dir > 0 ? "存了 " : "取了 ") + fmt(amt) + " · 进度 " + Math.min(100, Math.round(sv / g.target * 100)) + "%");
    });
  }

  /* ------------------------------------------------------------ 待办（存在日程 todos 里） */
  function todosHtml() {
    var ts = S.cal.todos || [], t0 = today();
    var open = ts.filter(function (t) { return !t.done; }).sort(function (a, b) {
      return (a.due || "9999") < (b.due || "9999") ? -1 : (a.due || "9999") > (b.due || "9999") ? 1 : (a.ts || 0) - (b.ts || 0);
    });
    var done = ts.filter(function (t) { return t.done; }).sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });
    var h = '<div class="sec"><h2>待办 <span class="dim small" style="font-weight:400">' + open.length + "</span></h2>" +
      (done.length ? '<button type="button" class="r" data-a="tdone">' + (S.showDone ? "收起完成的" : "完成的 " + done.length) + "</button>" : "") + "</div>" +
      '<div class="list"><div class="tadd"><input type="text" id="tnew" placeholder="加一条待办，回车" maxlength="80" enterkeyhint="done">' +
      '<button type="button" class="btn sm" data-a="tdate">' + (S.tdue ? esc(rel(S.tdue) || S.tdue.slice(5)) : "日期") + "</button></div>";
    open.concat(S.showDone ? done : []).forEach(function (t) {
      var late = t.due && t.due < t0 && !t.done;
      h += '<div class="todo' + (t.done ? " done" : "") + '" data-tid="' + esc(t.id) + '"><button type="button" class="ck" data-tck="' + esc(t.id) + '" aria-label="完成"></button>' +
        '<div class="grow"><div>' + esc(t.title) + "</div>" + (t.due ? '<div class="sub' + (late ? " neg" : "") + '">' + esc(nice(t.due)) + (late ? " · 过期了" : t.due === t0 ? " · 今天" : "") + "</div>" : "") + "</div></div>";
    });
    if (!open.length && !S.showDone) h += '<div class="empty" style="padding:16px">没有待办，清爽</div>';
    return h + "</div>";
  }
  function addTodo(title) {
    title = (title || "").trim();
    if (!title) return;
    S.cal.todos.push({ id: "t" + uid(), title: title.slice(0, 80), due: S.tdue || "", done: false, ts: Date.now() });
    S.tdue = "";
    changed("calendar");
    setTimeout(function () { var i = $("tnew"); if (i) i.focus(); }, 30);
  }
  function todoSheet(t) {
    var m = sheet("<h3>待办" + closeBtn() + "</h3>" +
      '<input type="text" id="t-title" maxlength="80" value="' + esc(t.title) + '">' +
      '<label class="f">日期（可不填）</label><input type="date" id="t-due" value="' + esc(t.due || "") + '">' +
      '<div class="acts"><button type="button" class="btn danger" data-x="del">删除</button><button type="button" class="btn pri" data-x="save">保存</button></div>');
    var q = function (id) { return m.querySelector("#" + id); };
    m.addEventListener("click", function (ev) {
      var x = ev.target.closest("[data-x]");
      if (!x) return;
      if (x.dataset.x === "close") { close(m); return; }
      if (x.dataset.x === "del") {
        var i = S.cal.todos.indexOf(t); S.cal.todos.splice(i, 1); close(m); changed("calendar");
        toast("删了「" + t.title + "」", "", { label: "撤销", run: function () { S.cal.todos.push(t); changed("calendar"); } }, 5000);
        return;
      }
      var ti = q("t-title").value.trim(), du = q("t-due").value;
      if (!ti) { toast("写点内容", "bad"); return; }
      t.title = ti.slice(0, 80); t.due = validDate(du) ? du : "";
      close(m); changed("calendar");
    });
  }
  function bindTodos() {
    var v = $("v-cal");
    v.addEventListener("keydown", function (e) {
      if (e.target.id === "tnew" && e.key === "Enter" && !e.isComposing) { e.preventDefault(); var val = e.target.value; e.target.value = ""; addTodo(val); }
    });
    v.addEventListener("click", function (e) {
      var ck = e.target.closest("[data-tck]"), td = e.target.closest(".todo[data-tid]"), a = e.target.closest("[data-a]");
      if (a && a.dataset.a === "tdone") { S.showDone = !S.showDone; render(); return; }
      if (a && a.dataset.a === "tdate") {
        var opts = [[today(), "今天"], [add(today(), 1), "明天"], [add(today(), 6 - dow(today())), "这周日"], ["", "不要日期"]];
        var m = sheet("<h3>什么时候" + closeBtn() + '</h3><div class="chips">' + opts.map(function (o) { return '<button type="button" class="chip' + (S.tdue === o[0] ? " on" : "") + '" data-td="' + o[0] + '">' + o[1] + "</button>"; }).join("") +
          '</div><label class="f">或者选一天</label><input type="date" id="td-pick" value="' + esc(S.tdue || "") + '">');
        m.addEventListener("click", function (ev) {
          var c = ev.target.closest("[data-td]"), x = ev.target.closest("[data-x]");
          if (x) { close(m); return; }
          if (c) { S.tdue = c.dataset.td; close(m); render(); }
        });
        m.querySelector("#td-pick").addEventListener("change", function (ev) { if (validDate(ev.target.value)) { S.tdue = ev.target.value; close(m); render(); } });
        return;
      }
      if (ck) {
        var t = S.cal.todos.filter(function (x) { return x.id === ck.dataset.tck; })[0];
        if (!t) return;
        t.done = !t.done; t.doneAt = t.done ? Date.now() : 0;
        var row = ck.closest(".todo");
        if (row) row.classList.toggle("done", t.done);
        haptic(1);
        setTimeout(function () { changed("calendar"); }, t.done ? 350 : 0);
        if (t.done) toast("完成「" + t.title + "」", "", { label: "撤销", run: function () { t.done = false; t.doneAt = 0; changed("calendar"); } }, 4000);
        return;
      }
      if (td) {
        var tt = S.cal.todos.filter(function (x) { return x.id === td.dataset.tid; })[0];
        if (tt) todoSheet(tt);
      }
    });
  }

  /* ------------------------------------------------------------ 超支提醒（记账首页） */
  function alertHtml(k, f) {
    if (S.month !== thisMonth()) return "";
    var over = [], near = [];
    k.rows.forEach(function (r) {
      var av = r.alloc + r.carry;
      if (r.loose || av <= 0) return;
      if (r.spent > av) over.push(r);
      else if (r.spent / av > Math.max(.9, f + .15)) near.push(r);
    });
    if (!over.length && !near.length) return "";
    var parts = over.map(function (r) { return esc(r.c.name) + " 超了 " + esc(fmt(r.spent - r.alloc - r.carry)); })
      .concat(near.map(function (r) { return esc(r.c.name) + " 只剩 " + esc(fmt(r.alloc + r.carry - r.spent)); }));
    return '<div class="banner ' + (over.length ? "bad" : "") + '"><span class="grow">' + (over.length ? "⚠️ " : "") + parts.slice(0, 3).join("，") + (parts.length > 3 ? " 等" : "") + "</span>" +
      '<button class="btn sm" type="button" data-a="goplan">调预算</button></div>';
  }

  var tabY = {};
  function go(tab) {
    var same = S.tab === tab && S.started && S.shown;
    if (S.started && S.shown) tabY[S.tab] = window.scrollY;
    S.tab = tab; S.shown = true;
    ["money", "stats", "plan", "cal", "set"].forEach(function (t) { $("v-" + t).hidden = t !== tab; });
    [].forEach.call($("tabs").children, function (b) { b.classList.toggle("on", b.dataset.v === tab); });
    $("title").textContent = TITLES[tab];
    $("fab").hidden = tab === "set";
    $("fab").setAttribute("aria-label", tab === "cal" ? "新日程" : "记一笔");
    S.deferred = false;
    render();
    /* 再点一次当前标签回到顶部；换标签回到上次看的位置 */
    if (same) window.scrollTo({ top: 0, behavior: "smooth" }); else window.scrollTo(0, tabY[tab] || 0);
    fabShow(true);
  }
  var fabY = 0;
  function fabShow(on) { $("fab").classList.toggle("away", !on); }
  window.addEventListener("scroll", function () {
    if (locked) return;
    var y = window.scrollY, dy = y - fabY;
    if (Math.abs(dy) < 6) return;
    fabShow(dy < 0 || y < 40 || y + innerHeight > document.documentElement.scrollHeight - 30);
    fabY = y;
  }, { passive: true });
  function render() {
    if (!S.started) return;
    /* 正在输入时同步回来的改动先不重画，免得把光标和输入冲掉；失焦后补一次 */
    var ae = document.activeElement, view = $("v-" + S.tab);
    if (ae && view && view.contains(ae) && /INPUT|TEXTAREA|SELECT/.test(ae.tagName) && ae.type !== "file" && ae.type !== "checkbox") {
      if (!S.deferred) {
        S.deferred = true;
        ae.addEventListener("blur", function () { setTimeout(function () { if (S.deferred) { S.deferred = false; render(); } }, 400); }, { once: true });
      }
      return;
    }
    if (S.tab === "money") renderMoney();
    if (S.tab === "stats") renderStats();
    if (S.tab === "plan") renderPlan();
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
    if (S.tab === "set" && S.started && !document.querySelector("#v-set :focus")) renderSet();
  }
  function start() {
    $("gate").hidden = true;
    $("app").hidden = false;
    $("tabs").hidden = false;
    return Promise.all([LabSync.getLocal("local:budget"), LabSync.getLocal("local:calendar")]).then(function (a) {
      S.budget = normB(a[0]);
      S.cal = normC(a[1]);
      S.month = thisMonth();
      S.calMonth = thisMonth();
      S.sel = today();
      S.fold = pref("fold") === "1";
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
      go(location.hash === "#cal" ? "cal" : location.hash === "#plan" ? "plan" : location.hash === "#stats" ? "stats" : "money");
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
    bindMoney(); bindStats(); bindPlan(); bindCal(); bindTodos(); bindSet();
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-n],.seg button,.tabs button,.chip,.cal .gr button,.fab,.sheet .btn.pri,[data-x=save],.sw input");
      if (b) haptic(1);
    }, true);
    $("tabs").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) go(b.dataset.v); });
    $("fab").addEventListener("click", function () { if (S.tab === "cal") evSheet(null, S.sel || today()); else txSheet({}); });
    $("syncbtn").addEventListener("click", function () {
      if (!LabSync.isReady()) { LabSync.dialog().then(function (ok) { if (ok === true && !S.started) start(); }); return; }
      LabSync.syncNow("budget"); LabSync.syncNow("calendar");
    });
    $("gatebtn").addEventListener("click", function () {
      LabSync.dialog({ mandatory: true }).then(function (ok) { if (ok === true) start(); });
    });
    window.addEventListener("hashchange", function () { if (S.started) handleHash(); });
    /* 从后台切回来：过了零点要换「今天」，顺手同步一次 */
    document.addEventListener("visibilitychange", function () {
      if (document.hidden || !S.started) return;
      if (LabSync.isReady()) { LabSync.syncNow("budget").catch(function () {}); LabSync.syncNow("calendar").catch(function () {}); }
      render();
    });
    if (!window.isSecureContext) { gate("要用 https 打开（phenolforever.com/app/）。"); return; }
    LabSync.ready().then(function (ok) {
      if (ok) start();
      else gate(location.hash.indexOf("ocr=") === 1 || location.hash.indexOf("add") === 1 ?
                "截图已经带过来了，连上同步以后会接着记。" : "");
    });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(function () {});
  });
})();
