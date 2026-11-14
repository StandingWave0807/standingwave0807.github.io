/* 日程页：月 / 周 / 列表三种日历视图。
   日程只经本机服务读写（sitekeeper/data/calendar.json，仓库外），浏览器里只存口令和视图偏好。
   笔记日期、预算里的固定收支、首页倒数日作为只读图层叠上来，这里不会改它们。 */
(function () {
  'use strict';

  var KEYNAME = "lab-keeper-key";
  var VIEWKEY = "lab-cl-view";
  var BASE = (function () {
    try {
      var q = new URLSearchParams(location.search).get("keeper");
      if (q && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(q)) return q;
    } catch (e) {}
    return "http://127.0.0.1:8720";
  })();
  var START_HINT = /Win/.test(navigator.platform || navigator.userAgent)
    ? "双击 sitekeeper\\start.cmd，" : "在终端里跑 python sitekeeper/keeper.py，";
  var PALETTE = ["#1f5c9e", "#1f7a3a", "#a15c00", "#8e3b8e", "#b42318", "#0f766e", "#6b6b6b", "#5b4bb7"];
  var WD = "一二三四五六日";
  var HOUR = 44;                 /* 周视图每小时的像素高，和 CSS 里的网格线对齐 */
  var DATERE = /^\d{4}-\d{2}-\d{2}$/;
  var REPN = { none: "", daily: "每天", weekdays: "工作日", weekly: "每周", biweekly: "每两周", monthly: "每月", yearly: "每年" };

  var $ = function (id) { return document.getElementById(id); };
  var S = { key: null, data: null, mtime: 0, saving: false, pending: false, tSave: null, connected: false,
            view: (function () { try { return localStorage.getItem(VIEWKEY) || "month"; } catch (e) { return "month"; } })(),
            anchor: today(), q: "", edit: null, ovl: { notes: [], bills: [], countdown: null }, scrolled: false };

  /* ------------------------------------------------------------ 日期工具（一律本地时间） */
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); }
  function today() { return ymd(new Date()); }
  function parse(s) { return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
  function add(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return ymd(d); }
  function diff(a, b) { return Math.round((parse(b) - parse(a)) / 864e5); }
  function dow(s) { return (parse(s).getDay() + 6) % 7; }          /* 周一 = 0 */
  function monday(s) { return add(s, -dow(s)); }
  function validDate(s) { return DATERE.test(s) && ymd(parse(s)) === s; }
  function mins(t) { return t ? (+t.slice(0, 2)) * 60 + (+t.slice(3, 5)) : 0; }
  function hm(m) { m = Math.max(0, Math.min(24 * 60 - 1, m)); return p2(Math.floor(m / 60)) + ":" + p2(m % 60); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function nice(s) { var d = parse(s); return (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + WD[dow(s)]; }

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
  function setStatus(t, cls) { var s = $("cl-status"); s.textContent = t; s.className = "passcount" + (cls ? " " + cls : ""); }

  /* ------------------------------------------------------------ 服务调用 */
  function api(path, opt) {
    opt = opt || {};
    opt.headers = { "Content-Type": "application/json", "X-Lab-Key": S.key || "" };
    return fetch(BASE + path, opt).catch(function () {
      var e = new Error("连不上本机服务"); e.status = 0; throw e;
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ("HTTP " + r.status)); e.status = r.status; e.body = j; throw e; }
        return j;
      });
    });
  }
  function fresh() {
    return { version: 1, cats: [{ id: "study", name: "学习", color: PALETTE[0] }, { id: "work", name: "工作", color: PALETTE[1] },
                                 { id: "life", name: "生活", color: PALETTE[2] }, { id: "misc", name: "其他", color: PALETTE[6] }],
             events: [], hide: [], show: { notes: true, bills: true, countdown: true } };
  }
  function normalize(d) {
    d = d && typeof d === "object" ? d : fresh();
    d.version = 1;
    d.cats = Array.isArray(d.cats) && d.cats.length ? d.cats : fresh().cats;
    d.events = Array.isArray(d.events) ? d.events : [];
    d.hide = Array.isArray(d.hide) ? d.hide : [];
    d.show = d.show && typeof d.show === "object" ? d.show : { notes: true, bills: true, countdown: true };
    return d;
  }
  function connect(key) {
    S.key = key;
    setStatus("连接中…");
    return api("/api/calendar").then(function (j) {
      S.connected = true;
      S.data = normalize(j.data);
      S.mtime = j.mtime || 0;
      $("cl-lock").hidden = true;
      $("cl-shell").hidden = false;
      setStatus(j.data ? "已连上 · 本机" : "已连上 · 新日历", "ok");
      if (!j.data) save(true);
      resetForm(today());
      render();
      loadOverlays();
      if (window.LabSync) {
        LabSync.attach("calendar", { get: function () { return S.data; }, normalize: normalize,
                                     set: function (d) { S.data = normalize(d); changed(); } });
        if (!S.syncBadge) { S.syncBadge = true; LabSync.badge(["calendar"]); }
      }
    });
  }
  /* 只读图层：拿不到就算了，不影响日程本身 */
  function loadOverlays() {
    api("/api/notes").then(function (j) {
      S.ovl.notes = (j.notes || []).filter(function (n) { return validDate(n.date || ""); });
      render();
    }).catch(function () {});
    api("/api/budget").then(function (j) {
      var d = j.data || {}, cats = {};
      (d.categories || []).forEach(function (c) { cats[c.id] = c.name; });
      S.ovl.bills = (d.recurring || []).map(function (r) {
        return { name: r.name, day: r.day, kind: r.kind, amt: r.amt, cur: d.currency || "¥", cat: cats[r.cat] || "" };
      });
      render();
    }).catch(function () {});
    api("/api/plan").then(function (j) {
      var p = j.data;
      if (p && p.target) { S.ovl.countdown = { label: p.label, d: p.target.slice(0, 10), t: p.target.slice(11, 16) }; render(); }
    }).catch(function () {});
  }
  function showLock(why) {
    S.connected = false;
    $("cl-lock").hidden = false;
    $("cl-shell").hidden = true;
    $("cl-lockmsg").textContent = why || "";
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
    askText("连接本机服务", "输入 sitekeeper 启动时打印的口令（只存这台电脑）", { ok: "连接", password: true }).then(function (r) {
      if (!r.ok) return;
      try { localStorage.setItem(KEYNAME, r.value); } catch (e) {}
      connect(r.value).catch(function (e) { failConnect(e, ""); });
    });
  }
  function changed() {
    S.pending = true;
    setStatus("有改动 · 待存", "");
    clearTimeout(S.tSave);
    S.tSave = setTimeout(function () { save(); }, 400);
    render();
  }
  function save(quiet) {
    if (S.saving) { S.pending = true; return; }
    S.saving = true;
    S.pending = false;
    if (!quiet) setStatus("保存中…");
    return api("/api/calendar", { method: "POST", body: JSON.stringify({ data: S.data, base: S.mtime || null }) })
      .then(function (j) {
        S.mtime = j.mtime;
        if (window.LabSync) LabSync.kick("calendar");
        var d = new Date();
        setStatus("已存 " + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()), "ok");
      })
      .catch(function (e) {
        if (e.status === 409) {
          S.data = normalize(e.body.data);
          S.mtime = e.body.mtime;
          render();
          toast("别的标签页刚存过日历，已换成那一版。你刚才那一步没存上，再做一次。", "bad", null, 6000);
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

  /* ------------------------------------------------------------ 重复规则展开 */
  function catOf(id) {
    for (var i = 0; i < S.data.cats.length; i++) if (S.data.cats[i].id === id) return S.data.cats[i];
    return S.data.cats[S.data.cats.length - 1];
  }
  function spanOf(ev) { return ev.allDay && ev.end && ev.end > ev.date ? diff(ev.date, ev.end) : 0; }
  /* 起始日落在 [from - 跨度, to] 里的每一次 */
  function starts(ev, from, to) {
    var out = [], len = spanOf(ev), lo = add(from, -len), d = ev.date, n = 0;
    var until = ev.until && validDate(ev.until) ? ev.until : "9999-12-31";
    var ex = ev.ex || [];
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
  function matchQ(t) { return !S.q || t.toLowerCase().indexOf(S.q.toLowerCase()) >= 0; }
  /* 区间里所有要画的条目（含只读图层），已按开始时间排好 */
  function instances(from, to) {
    var out = [], hide = S.data.hide, show = S.data.show;
    S.data.events.forEach(function (ev) {
      if (hide.indexOf(ev.cat) >= 0) return;
      if (!matchQ(ev.title + " " + (ev.note || ""))) return;
      var len = spanOf(ev);
      starts(ev, from, to).forEach(function (d) {
        out.push({ ev: ev, d: d, e: add(d, len), all: !!ev.allDay, t: ev.allDay ? "" : ev.start, f: ev.allDay ? "" : ev.finish,
                   title: ev.title, color: catOf(ev.cat).color });
      });
    });
    if (show.notes) S.ovl.notes.forEach(function (n) {
      if (n.date >= from && n.date <= to && matchQ(n.title)) out.push({ ro: "notes", d: n.date, e: n.date, all: true, title: "笔记 · " + n.title, href: "/notes/" + n.slug + "/", color: "var(--dim)" });
    });
    if (show.bills && S.ovl.bills.length) {
      var m = from.slice(0, 8) + "01";
      for (; m <= to; m = ymd(new Date(+m.slice(0, 4), +m.slice(5, 7), 1))) {
        var dim = new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
        S.ovl.bills.forEach(function (b) {
          var d = m.slice(0, 8) + p2(Math.min(b.day, dim));
          var t = (b.kind === "in" ? "进账 · " : "付款 · ") + b.name;
          if (d >= from && d <= to && matchQ(t)) out.push({ ro: "bills", d: d, e: d, all: true, title: t, color: b.kind === "in" ? "var(--ok)" : "var(--warn)",
            tip: b.cat + " " + b.cur + (b.amt / 100).toFixed(2).replace(/\.00$/, "") });
        });
      }
    }
    var c = S.ovl.countdown;
    if (show.countdown && c && c.d >= from && c.d <= to && matchQ(c.label)) out.push({ ro: "countdown", d: c.d, e: c.d, all: false, t: c.t, f: c.t, title: "倒数 · " + c.label, color: "var(--fg)" });
    out.sort(function (a, b) {
      if (a.d !== b.d) return a.d < b.d ? -1 : 1;
      if (a.all !== b.all) return a.all ? -1 : 1;
      return (a.t || "") < (b.t || "") ? -1 : (a.t || "") > (b.t || "") ? 1 : 0;
    });
    return out;
  }
  function chip(it, opts) {
    opts = opts || {};
    var past = (it.e < today()) || (it.e === today() && !it.all && it.f && it.f < hm(new Date().getHours() * 60 + new Date().getMinutes()));
    var cls = "ev" + (it.ro ? " ro" + (it.href ? " link" : "") : (it.all ? " all" : "")) + (past ? " past" : "") +
      (S.edit && it.ev && S.edit.id === it.ev.id && S.edit.d === it.d ? " sel" : "") + (S.q && !it.ro ? " hit" : "");
    var rep = it.ev && it.ev.rep && it.ev.rep !== "none" ? " ↻" : "";
    var tip = it.title + (it.t ? " " + it.t + (it.f && it.f !== it.t ? "–" + it.f : "") : "") + (it.tip ? " · " + it.tip : "") +
      (it.ev && it.ev.note ? "\n" + it.ev.note : "") + (it.ev && rep ? "\n" + REPN[it.ev.rep] + "重复" : "");
    return '<div class="' + cls + '" style="--c:' + esc(it.color) + (opts.style || "") + '"' +
      (it.ev ? ' data-id="' + esc(it.ev.id) + '" data-d="' + it.d + '" draggable="true"' : "") +
      (it.href ? ' data-href="' + esc(it.href) + '"' : "") + ' title="' + esc(tip) + '">' +
      (it.t && !opts.noTime ? '<span class="tm">' + esc(it.t) + "</span>" : "") +
      '<span class="tt">' + esc(it.title) + rep + "</span>" + (opts.extra || "") + "</div>";
  }

  /* ------------------------------------------------------------ 渲染 */
  function render() {
    if (!S.data) return;
    [].forEach.call($("cl-views").children, function (b) { b.classList.toggle("on", b.dataset.v === S.view); });
    if (S.view === "week") renderWeek();
    else if (S.view === "list") renderList();
    else renderMonth();
    renderSide();
  }
  function renderMonth() {
    var a = S.anchor, first = a.slice(0, 8) + "01";
    var y = +a.slice(0, 4), mo = +a.slice(5, 7);
    $("cl-title").textContent = y + " 年 " + mo + " 月";
    var from = monday(first), last = ymd(new Date(y, mo, 0)), to = add(monday(last), 6);
    var items = instances(from, to), t = today();
    var h = "";
    for (var i = 0; i < 7; i++) h += '<div class="cl-wd">周' + WD[i] + "</div>";
    for (var d = from; d <= to; d = add(d, 1)) {
      var mine = items.filter(function (it) { return it.d <= d && it.e >= d; });
      var cls = "cl-day" + (d.slice(0, 7) !== a.slice(0, 7) ? " out" : "") + (d === t ? " today" : "") + (dow(d) > 4 ? " we" : "");
      h += '<div class="' + cls + '" data-day="' + d + '"><span class="dn">' + (+d.slice(8)) + (d.slice(8) === "01" ? " · " + (+d.slice(5, 7)) + "月" : "") + "</span>";
      var max = 4;
      mine.slice(0, mine.length > max ? max - 1 : max).forEach(function (it) {
        var cont = it.d < d && dow(d) !== 0 ? "" : "";
        h += chip(it, { noTime: it.d !== d }) + cont;
      });
      if (mine.length > max) h += '<div class="more" data-week="' + d + '">还有 ' + (mine.length - max + 1) + " 项</div>";
      h += "</div>";
    }
    var v = $("cl-view");
    v.innerHTML = '<div class="cl-month" style="grid-template-rows:auto">' + h + "</div>";
  }
  function renderWeek() {
    var from = monday(S.anchor), to = add(from, 6), t = today();
    var a = parse(from), b = parse(to);
    $("cl-title").textContent = a.getFullYear() + " 年 " + (a.getMonth() + 1) + "月" + a.getDate() + "日 – " +
      (b.getMonth() !== a.getMonth() ? (b.getMonth() + 1) + "月" : "") + b.getDate() + "日";
    var items = instances(from, to);
    var h = '<div class="cl-wd"></div>';
    var d, i;
    for (i = 0, d = from; i < 7; i++, d = add(d, 1)) {
      h += '<div class="cl-wd' + (d === t ? " today" : "") + '">周' + WD[i] + "<b>" + (+d.slice(8)) + "</b></div>";
    }
    h += '<div class="cl-gut">全天</div>';
    for (i = 0, d = from; i < 7; i++, d = add(d, 1)) {
      var day = d;
      h += '<div class="cl-alld" data-day="' + d + '">' + items.filter(function (it) { return (it.all || !it.t) && it.d <= day && it.e >= day; })
        .map(function (it) { return chip(it); }).join("") + "</div>";
    }
    h += '<div class="cl-hours">';
    for (i = 0; i < 24; i++) h += "<div>" + (i ? p2(i) + ":00" : "") + "</div>";
    h += "</div>";
    for (i = 0, d = from; i < 7; i++, d = add(d, 1)) {
      var dd = d;
      var timed = items.filter(function (it) { return !it.all && it.t && it.d === dd; });
      /* 重叠的并排：贪心分车道，同一簇里平分宽度 */
      var lanes = [], clusterEnd = -1, cluster = [];
      function flush() { var n = lanes.length; cluster.forEach(function (c) { c.n = n; }); lanes = []; cluster = []; }
      timed.forEach(function (it) {
        var s = mins(it.t), e = Math.max(s + 30, it.f && mins(it.f) > s ? mins(it.f) : s + 60);
        if (s >= clusterEnd) flush();
        var L = 0;
        while (L < lanes.length && lanes[L] > s) L++;
        lanes[L] = e;
        it._s = s; it._e = e; it._l = L;
        cluster.push(it);
        clusterEnd = Math.max(clusterEnd, e);
      });
      flush();
      h += '<div class="cl-col' + (d === t ? " today" : "") + '" data-day="' + d + '" style="height:' + 24 * HOUR + 'px">';
      timed.forEach(function (it) {
        var w = 100 / it.n;
        h += chip(it, { style: ";top:" + (it._s / 60 * HOUR) + "px;height:" + Math.max(20, (it._e - it._s) / 60 * HOUR - 2) + "px;left:calc(" + (it._l * w) + "% + 2px);right:auto;width:calc(" + w + "% - 4px)",
                        extra: it.f && it.f !== it.t ? '<span class="tm">' + esc(it.t) + "–" + esc(it.f) + "</span>" : "", noTime: true });
      });
      if (d === t) { var nw = new Date(); h += '<div class="cl-now" style="top:' + ((nw.getHours() * 60 + nw.getMinutes()) / 60 * HOUR) + 'px"></div>'; }
      h += "</div>";
    }
    var v = $("cl-view");
    v.innerHTML = '<div class="cl-week">' + h + "</div>";
    if (!S.scrolled) { v.scrollTop = 7.5 * HOUR; S.scrolled = true; }
  }
  function renderList() {
    var from = S.q ? add(today(), -366) : S.anchor, to = S.q ? add(today(), 366) : add(S.anchor, 59), t = today();
    $("cl-title").textContent = S.q ? "搜索「" + S.q + "」" : nice(from) + " 起 60 天";
    var items = instances(from, to), byDay = {}, days = [];
    items.forEach(function (it) {
      var dd = it.d < from ? from : it.d;
      if (!byDay[dd]) { byDay[dd] = []; days.push(dd); }
      byDay[dd].push(it);
    });
    days.sort();
    var h = days.map(function (d) {
      return '<div class="cl-lday' + (d === t ? " today" : "") + '" data-day="' + d + '"><div class="d">' + (+d.slice(5, 7)) + "月" + (+d.slice(8)) + "日<small>周" + WD[dow(d)] +
        (d.slice(0, 4) !== t.slice(0, 4) ? " · " + d.slice(0, 4) : "") + "</small></div><div>" +
        byDay[d].map(function (it) {
          var x = it.e > it.d ? '<span class="nt">到 ' + (+it.e.slice(5, 7)) + "月" + (+it.e.slice(8)) + "日</span>" :
            (it.f && it.f !== it.t ? '<span class="nt">到 ' + esc(it.f) + "</span>" : "");
          if (it.ev && it.ev.note) x += '<span class="nt">' + esc(it.ev.note.split("\n")[0]) + "</span>";
          return chip(it, { extra: x });
        }).join("") + "</div></div>";
    }).join("");
    $("cl-view").innerHTML = '<div class="cl-list">' + (h || '<div class="bg-empty">' + (S.q ? "前后一年里没搜到。" : "这 60 天里还没有安排。在左边写一条，或者切到月视图点空白格子。") + "</div>") + "</div>";
  }
  function renderSide() {
    var t = today(), up = instances(t, add(t, 13)).filter(function (it) {
      return it.e > t || it.all || !it.f || it.f >= hm(new Date().getHours() * 60 + new Date().getMinutes());
    });
    $("cl-upcount").textContent = up.length ? up.length + " 项" : "";
    $("cl-up").innerHTML = up.slice(0, 14).map(function (it) {
      var d = it.d < t ? t : it.d, w = d === t ? "今天" : d === add(t, 1) ? "明天" : (+d.slice(5, 7)) + "/" + (+d.slice(8)) + " 周" + WD[dow(d)];
      return '<div style="display:flex;gap:6px;align-items:baseline"><span class="when">' + w + (it.t && !it.all ? " " + it.t : "") + "</span>" + chip(it, { noTime: true, style: ";flex:1" }) + "</div>";
    }).join("") || '<div class="none">两周内没有安排。</div>';
    $("cl-cats").innerHTML = S.data.cats.map(function (c) {
      return '<label class="cl-chk" style="--c:' + esc(c.color) + '"><input type="checkbox" data-cat="' + esc(c.id) + '"' + (S.data.hide.indexOf(c.id) < 0 ? " checked" : "") +
        '> <i></i>' + esc(c.name) + '<button type="button" class="ren" data-ren="' + esc(c.id) + '" title="改名 / 删除">改</button></label>';
    }).join("");
    [].forEach.call(document.querySelectorAll("#cl-ovl input"), function (x) { x.checked = !!S.data.show[x.dataset.ovl]; });
    var ec = $("e-cats"), cur = ec.dataset.v || S.data.cats[0].id;
    if (!catOf(cur) || catOf(cur).id !== cur) cur = S.data.cats[0].id;
    ec.innerHTML = S.data.cats.map(function (c) {
      return '<button type="button" class="chip' + (c.id === cur ? " on" : "") + '" data-cat="' + esc(c.id) + '" style="border-left-color:' + esc(c.color) +
        (c.id === cur ? ";background:" + esc(c.color) + ";border-color:" + esc(c.color) : "") + '">' + esc(c.name) + "</button>";
    }).join("");
    ec.dataset.v = cur;
  }

  /* ------------------------------------------------------------ 表单 */
  function syncForm() {
    var all = $("e-allday").checked;
    $("e-times").hidden = all;
    $("e-endwrap").hidden = !all;
    $("e-until").hidden = $("e-rep").value === "none";
  }
  function resetForm(date, time) {
    S.edit = null;
    $("cl-formt").textContent = "新日程";
    $("cl-new").hidden = true;
    $("e-title").value = "";
    $("e-date").value = date || today();
    $("e-allday").checked = !time && false;
    $("e-end").value = "";
    $("e-start").value = time || "09:00";
    $("e-finish").value = hm(mins(time || "09:00") + 60);
    $("e-rep").value = "none";
    $("e-until").value = "";
    $("e-rem").value = "";
    $("e-note").value = "";
    $("e-save").textContent = "加上（Ctrl+Enter）";
    $("e-del").hidden = true;
    $("e-cancel").hidden = true;
    var x = $("e-delall"); if (x) x.remove();
    syncForm();
    if (S.data) render();
  }
  function loadForm(ev, d) {
    S.edit = { id: ev.id, d: d };
    var rep = ev.rep && ev.rep !== "none";
    $("cl-formt").textContent = rep ? "改重复日程（改的是整个系列）" : "改日程";
    $("cl-new").hidden = false;
    $("e-title").value = ev.title;
    $("e-date").value = ev.date;
    $("e-allday").checked = !!ev.allDay;
    $("e-end").value = ev.end || "";
    $("e-start").value = ev.start || "09:00";
    $("e-finish").value = ev.finish || "10:00";
    $("e-rep").value = ev.rep || "none";
    $("e-until").value = ev.until || "";
    $("e-rem").value = ev.remind === undefined || ev.remind === null ? "" : String(ev.remind);
    $("e-note").value = ev.note || "";
    $("e-cats").dataset.v = ev.cat;
    $("e-save").textContent = "保存";
    $("e-del").hidden = false;
    $("e-del").textContent = rep ? "只删 " + (+d.slice(5, 7)) + "/" + (+d.slice(8)) + " 这次" : "删除";
    $("e-cancel").hidden = false;
    var x = $("e-delall");
    if (rep && !x) {
      x = document.createElement("button");
      x.type = "button"; x.id = "e-delall"; x.textContent = "删整个系列";
      x.style.cssText = "color:var(--bad);border-color:var(--bad)";
      x.addEventListener("click", function () { delEvent(true); });
      $("e-cancel").before(x);
    } else if (!rep && x) x.remove();
    syncForm();
    render();
    $("e-title").focus();
  }
  function submitForm(e) {
    if (e) e.preventDefault();
    var title = $("e-title").value.trim(), date = $("e-date").value.trim(), all = $("e-allday").checked;
    if (!title) { $("e-title").focus(); toast("写个标题", "bad"); return; }
    if (!validDate(date)) { $("e-date").focus(); toast("日期写成 2026-11-14 这样", "bad"); return; }
    var end = $("e-end").value.trim(), until = $("e-until").value.trim(), st = $("e-start").value, fi = $("e-finish").value;
    if (all && end && (!validDate(end) || end < date)) { toast("结束日期不对（要不早于开始）", "bad"); return; }
    if (until && (!validDate(until) || until < date)) { toast("截止日不对（要不早于开始）", "bad"); return; }
    if (!all && (!st || (fi && fi <= st))) { toast("结束时间要晚于开始", "bad"); return; }
    var ev = S.edit ? S.data.events.find(function (x) { return x.id === S.edit.id; }) : null;
    var isNew = !ev;
    if (!ev) { ev = { id: uid(), ex: [] }; S.data.events.push(ev); }
    ev.title = title.slice(0, 80); ev.date = date; ev.allDay = all;
    ev.end = all && end && end > date ? end : "";
    ev.start = all ? "" : st; ev.finish = all ? "" : (fi || hm(mins(st) + 60));
    ev.cat = $("e-cats").dataset.v; ev.rep = $("e-rep").value; ev.until = ev.rep === "none" ? "" : until;
    ev.note = $("e-note").value.trim();
    if ($("e-rem").value === "") delete ev.remind; else ev.remind = +$("e-rem").value;
    ev.ex = ev.ex || [];
    if (S.view === "month" && date.slice(0, 7) !== S.anchor.slice(0, 7)) S.anchor = date;
    if (S.view === "week" && monday(date) !== monday(S.anchor)) S.anchor = date;
    resetForm(date);
    changed();
    toast(isNew ? "加上了：" + nice(date) + " " + ev.title : "改好了", "", isNew ? { label: "撤销", run: function () {
      S.data.events = S.data.events.filter(function (x) { return x.id !== ev.id; }); changed();
    } } : null);
  }
  function delEvent(series) {
    if (!S.edit) return;
    var ev = S.data.events.find(function (x) { return x.id === S.edit.id; });
    if (!ev) return;
    var rep = ev.rep && ev.rep !== "none", d = S.edit.d, snap = JSON.parse(JSON.stringify(S.data.events));
    var go = function () {
      if (rep && !series) { ev.ex = (ev.ex || []).concat([d]); }
      else S.data.events = S.data.events.filter(function (x) { return x.id !== ev.id; });
      resetForm(d);
      changed();
      toast(rep && !series ? "删了 " + nice(d) + " 这一次" : "删了「" + ev.title + "」", "", { label: "撤销", run: function () { S.data.events = snap; changed(); } }, 5000);
    };
    if (rep && series) ask("删掉整个重复系列「" + ev.title + "」？以前和以后的每一次都会消失。", { ok: "删整个系列" }).then(function (y) { if (y) go(); });
    else go();
  }
  /* 拖到另一天：挪的是这一条（重复日程整体平移同样天数） */
  function moveTo(id, fromD, toD) {
    var ev = S.data.events.find(function (x) { return x.id === id; });
    if (!ev || fromD === toD) return;
    var n = diff(fromD, toD), snap = JSON.stringify(ev);
    ev.date = add(ev.date, n);
    if (ev.end) ev.end = add(ev.end, n);
    if (ev.ex && ev.ex.length) ev.ex = ev.ex.map(function (x) { return add(x, n); });
    if (ev.until) ev.until = add(ev.until, n);
    changed();
    toast("挪到 " + nice(toD) + (ev.rep && ev.rep !== "none" ? "（整个系列一起挪了）" : ""), "", { label: "撤销", run: function () {
      var o = JSON.parse(snap), i = S.data.events.findIndex(function (x) { return x.id === id; });
      if (i >= 0) { S.data.events[i] = o; changed(); }
    } }, 5000);
  }

  /* ------------------------------------------------------------ 导出 */
  function download(name, text, type) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function icsText(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, "\\$&"); }
  function exportIcs() {
    var R = { daily: "FREQ=DAILY", weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", weekly: "FREQ=WEEKLY", biweekly: "FREQ=WEEKLY;INTERVAL=2", monthly: "FREQ=MONTHLY", yearly: "FREQ=YEARLY" };
    var stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    var L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//phenolforever//calendar//ZH", "CALSCALE:GREGORIAN"];
    S.data.events.forEach(function (ev) {
      var dd = ev.date.replace(/-/g, "");
      L.push("BEGIN:VEVENT", "UID:" + ev.id + "@phenolforever", "DTSTAMP:" + stamp, "SUMMARY:" + icsText(ev.title));
      if (ev.allDay) { L.push("DTSTART;VALUE=DATE:" + dd, "DTEND;VALUE=DATE:" + add(ev.end || ev.date, 1).replace(/-/g, "")); }
      else { L.push("DTSTART:" + dd + "T" + ev.start.replace(":", "") + "00", "DTEND:" + dd + "T" + (ev.finish || ev.start).replace(":", "") + "00"); }
      if (ev.rep && R[ev.rep]) L.push("RRULE:" + R[ev.rep] + (ev.until ? ";UNTIL=" + ev.until.replace(/-/g, "") + (ev.allDay ? "" : "T235959") : ""));
      (ev.ex || []).forEach(function (x) {
        L.push(ev.allDay ? "EXDATE;VALUE=DATE:" + x.replace(/-/g, "") : "EXDATE:" + x.replace(/-/g, "") + "T" + ev.start.replace(":", "") + "00");
      });
      if (ev.note) L.push("DESCRIPTION:" + icsText(ev.note));
      if (ev.remind !== undefined && ev.remind !== null && ev.remind !== "") {
        /* 全天日程按当天 9 点算提醒，和手机 App 一致 */
        var before = ev.allDay ? +ev.remind - 9 * 60 : +ev.remind;
        L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsText(ev.title),
               "TRIGGER:" + (before <= 0 ? "PT" + (-before) + "M" : "-PT" + before + "M"), "END:VALARM");
      }
      L.push("CATEGORIES:" + icsText(catOf(ev.cat).name), "END:VEVENT");
    });
    L.push("END:VCALENDAR");
    download("calendar-" + today() + ".ics", L.join("\r\n") + "\r\n", "text/calendar;charset=utf-8");
  }

  /* ------------------------------------------------------------ 事件 */
  function step(k) {
    if (S.view === "week") S.anchor = add(S.anchor, 7 * k);
    else if (S.view === "list") S.anchor = add(S.anchor, 60 * k);
    else { var d = parse(S.anchor); S.anchor = ymd(new Date(d.getFullYear(), d.getMonth() + k, 1)); }
    render();
  }
  function setView(v) {
    S.view = v;
    S.scrolled = false;
    try { localStorage.setItem(VIEWKEY, v); } catch (e) {}
    render();
  }
  function typing(e) {
    var t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  }
  function bind() {
    $("cl-retry").addEventListener("click", askKey);
    $("cl-prev").addEventListener("click", function () { step(-1); });
    $("cl-next").addEventListener("click", function () { step(1); });
    $("cl-today").addEventListener("click", function () { S.anchor = today(); S.scrolled = false; render(); });
    $("cl-views").addEventListener("click", function (e) { var b = e.target.closest("[data-v]"); if (b) setView(b.dataset.v); });
    $("cl-q").addEventListener("input", function () { S.q = this.value.trim(); render(); });
    $("cl-q").addEventListener("keydown", function (e) { if (e.key === "Escape") { this.value = ""; S.q = ""; render(); this.blur(); } });

    $("cl-form").addEventListener("submit", submitForm);
    $("cl-form").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitForm(); }
      else if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "checkbox") { e.preventDefault(); submitForm(); }
      else if (e.key === "Escape" && S.edit) { resetForm($("e-date").value); }
    });
    $("e-allday").addEventListener("change", syncForm);
    $("e-rep").addEventListener("change", syncForm);
    $("e-start").addEventListener("change", function () {
      var f = $("e-finish");
      if (!f.value || f.value <= this.value) f.value = hm(mins(this.value) + 60);
    });
    $("e-datebtn").addEventListener("click", function () {
      var v = $("e-date").value;
      datePicker(this, { value: validDate(v) ? parse(v) : new Date(), onPick: function (d) { $("e-date").value = ymd(d); } });
    });
    $("e-cats").addEventListener("click", function (e) {
      var b = e.target.closest("[data-cat]");
      if (!b) return;
      this.dataset.v = b.dataset.cat;
      renderSide();
    });
    $("e-del").addEventListener("click", function () { delEvent(false); });
    $("e-cancel").addEventListener("click", function () { resetForm($("e-date").value); });
    $("cl-new").addEventListener("click", function () { resetForm($("e-date").value); $("e-title").focus(); });

    var view = $("cl-view");
    view.addEventListener("click", function (e) {
      var ch = e.target.closest(".ev");
      if (ch) {
        if (ch.dataset.href) { window.open(ch.dataset.href, "_blank"); return; }
        if (!ch.dataset.id) return;
        var ev = S.data.events.find(function (x) { return x.id === ch.dataset.id; });
        if (ev) loadForm(ev, ch.dataset.d);
        return;
      }
      var more = e.target.closest("[data-week]");
      if (more) { S.anchor = more.dataset.week; setView("week"); return; }
      var col = e.target.closest(".cl-col");
      if (col) {
        var r = col.getBoundingClientRect(), m = Math.floor(((e.clientY - r.top) / HOUR * 60) / 30) * 30;
        resetForm(col.dataset.day, hm(m));
        $("e-title").focus();
        return;
      }
      var day = e.target.closest("[data-day]");
      if (day) {
        resetForm(day.dataset.day);
        if (day.classList.contains("cl-alld")) { $("e-allday").checked = true; syncForm(); }
        $("e-title").focus();
      }
    });
    /* 拖拽改日期（月视图的格子、周视图的全天行和每一列） */
    var dragging = null;
    view.addEventListener("dragstart", function (e) {
      var ch = e.target.closest(".ev[data-id]");
      if (!ch) return;
      dragging = { id: ch.dataset.id, d: ch.dataset.d };
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", ch.dataset.id); } catch (_) {}
    });
    view.addEventListener("dragover", function (e) {
      var day = dragging && e.target.closest("[data-day]");
      if (!day) return;
      e.preventDefault();
      [].forEach.call(view.querySelectorAll(".drop"), function (x) { if (x !== day) x.classList.remove("drop"); });
      day.classList.add("drop");
    });
    view.addEventListener("drop", function (e) {
      var day = dragging && e.target.closest("[data-day]");
      if (!day) return;
      e.preventDefault();
      var dg = dragging;
      dragging = null;
      moveTo(dg.id, dg.d, day.dataset.day);
    });
    view.addEventListener("dragend", function () {
      dragging = null;
      [].forEach.call(view.querySelectorAll(".drop"), function (x) { x.classList.remove("drop"); });
    });

    $("cl-up").addEventListener("click", function (e) {
      var ch = e.target.closest(".ev");
      if (!ch) return;
      if (ch.dataset.href) { window.open(ch.dataset.href, "_blank"); return; }
      var ev = ch.dataset.id && S.data.events.find(function (x) { return x.id === ch.dataset.id; });
      if (ev) loadForm(ev, ch.dataset.d);
    });
    $("cl-cats").addEventListener("change", function (e) {
      var id = e.target.dataset.cat;
      if (!id) return;
      S.data.hide = S.data.hide.filter(function (x) { return x !== id; });
      if (!e.target.checked) S.data.hide.push(id);
      changed();
    });
    $("cl-cats").addEventListener("click", function (e) {
      var b = e.target.closest("[data-ren]");
      if (!b) return;
      e.preventDefault();
      var c = catOf(b.dataset.ren);
      var rest = S.data.cats.filter(function (x) { return x !== c; });
      askText("改分类", rest.length ? "新名字。输入「删除」就删掉这个分类，里面的日程归到「" + rest[0].name + "」。" : "新名字",
              { ok: "确定", value: c.name }).then(function (r) {
        if (!r.ok) return;
        if (r.value === "删除" && rest.length) {
          S.data.events.forEach(function (ev) { if (ev.cat === c.id) ev.cat = rest[0].id; });
          S.data.cats = rest;
          S.data.hide = S.data.hide.filter(function (x) { return x !== c.id; });
          changed();
          toast("删了分类「" + c.name + "」", "");
          return;
        }
        c.name = r.value.slice(0, 12);
        changed();
      });
    });
    $("cl-ovl").addEventListener("change", function (e) {
      var k = e.target.dataset.ovl;
      if (!k) return;
      S.data.show[k] = e.target.checked;
      changed();
    });
    $("cl-catadd").addEventListener("click", function () {
      askText("新分类", "叫什么？", { ok: "加上" }).then(function (r) {
        var v = r.ok && r.value.trim();
        if (!v) return;
        if (S.data.cats.some(function (c) { return c.name === v; })) { toast("已经有这个分类了", "bad"); return; }
        var used = S.data.cats.map(function (c) { return c.color; });
        var color = PALETTE.filter(function (p) { return used.indexOf(p) < 0; })[0] || PALETTE[S.data.cats.length % PALETTE.length];
        S.data.cats.push({ id: "c" + uid(), name: v.slice(0, 12), color: color });
        changed();
      });
    });
    $("cl-ics").addEventListener("click", exportIcs);
    $("cl-json").addEventListener("click", function () {
      download("calendar-backup-" + today() + ".json", JSON.stringify(S.data, null, 1), "application/json");
    });

    document.addEventListener("keydown", function (e) {
      if (!S.connected || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      if (document.querySelector("#askMask.show")) return;
      var k = e.key;
      if (k === "/") { e.preventDefault(); $("cl-q").focus(); }
      else if (k === "[") step(-1);
      else if (k === "]") step(1);
      else if (k === "t") { S.anchor = today(); S.scrolled = false; render(); }
      else if (k === "m") setView("month");
      else if (k === "w") setView("week");
      else if (k === "l") setView("list");
      else if (k === "n") { e.preventDefault(); resetForm(S.view === "month" && S.anchor.slice(0, 7) !== today().slice(0, 7) ? S.anchor.slice(0, 8) + "01" : today()); $("e-title").focus(); }
      else if (k === "Escape" && S.edit) resetForm($("e-date").value);
    });
    /* 跨过零点、周视图的「现在」红线，每分钟对一次 */
    setInterval(function () { if (S.connected && !document.hidden && !S.edit && !typing({ target: document.activeElement })) render(); }, 60000);
    window.addEventListener("beforeunload", function (e) { if (S.pending || S.saving) { e.preventDefault(); e.returnValue = ""; } });
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
