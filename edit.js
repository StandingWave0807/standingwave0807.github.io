/* 笔记编辑面板。所有写动作都经本机服务（sitekeeper/keeper.py），
   浏览器里没有 GitHub 凭据，只有一个本机口令。 */
(function () {
  'use strict';

  var KEYNAME = "lab-keeper-key";
  var BASE = (function () {
    try {
      var q = new URLSearchParams(location.search).get("keeper");
      if (q && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(q)) return q;
    } catch (e) {}
    return "http://127.0.0.1:8720";
  })();
  var CATS = { cs: "计算机", ai: "人工智能", math: "数学", phy: "物理" };
  var SLUGRE = /^[a-z0-9][a-z0-9-]{1,79}$/;
  var DATERE = /^\d{4}-\d{2}-\d{2}$/;

  var $ = function (id) { return document.getElementById(id); };
  var f = {
    title: $("f-title"), date: $("f-date"), sub: $("f-sub"), slug: $("f-slug"),
    body: $("f-body")
  };
  var ed = null;                       /* CodeMirror 实例 */
  function bodyText() { return ed ? ed.getValue() : ""; }
  function setBody(t) { if (ed) ed.setValue(t); }
  var list = $("ed-list"), status = $("ed-status"), msg = $("ed-msg"), preview = $("ed-preview");
  var state = { notes: [], drafts: {}, slug: null, key: null, dirty: false };
  var tDraft = null, tPreview = null;

  /* ---------------------------------------------------------------- 服务调用 */
  function api(path, opt) {
    opt = opt || {};
    opt.headers = { "Content-Type": "application/json", "X-Lab-Key": state.key || "" };
    return fetch(BASE + path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var err = new Error(j.error || j.why || ("HTTP " + r.status));
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }

  function setStatus(text, cls) {
    status.textContent = text;
    status.className = "passcount" + (cls ? " " + cls : "");
  }

  function say(text, kind) {
    msg.textContent = text || "";
    msg.className = "ed-msg" + (kind ? " " + kind : "");
    msg.hidden = !text;
  }

  /* ------------------------------------------------------------ md <-> 字段 */
  function parseMd(md) {
    var m = /^---\n([\s\S]*?)\n---\n?/.exec(md || "");
    var meta = { title: "", date: "", cat: "cs", sub: "", slug: "", tags: [] };
    if (m) {
      m[1].split("\n").forEach(function (line) {
        var i = line.indexOf(":");
        if (i < 0) return;
        var k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (k === "tags") meta.tags = (v.replace(/^\[|\]$/g, "") || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        else if (meta.hasOwnProperty(k)) meta[k] = v;
      });
      return { meta: meta, body: (md || "").slice(m[0].length) };
    }
    return { meta: meta, body: md || "" };
  }

  function current() {
    return {
      slug: f.slug.value.trim(),
      meta: {
        title: f.title.value.trim(), date: f.date.value.trim(), cat: pickedCat(),
        sub: f.sub.value.trim(), slug: f.slug.value.trim(), tags: tagList()
      },
      body: bodyText()
    };
  }

  function fill(meta, body) {
    loading = true;
    f.title.value = meta.title || "";
    f.date.value = meta.date || "";
    f.sub.value = meta.sub || "";
    f.slug.value = meta.slug || "";
    setBody(body || "");
    setCat(meta.cat || "math");
    setTags(meta.tags || []);
    loading = false;
  }

  /* 程序化填内容也会触发编辑器的 change，不能当成"用户改了东西"，
     否则光是打开一条笔记就会凭空生成一份草稿 */
  var loading = false;

  /* ---------------------------------------------------------------- 学科 chips */
  function catBox() { return $("ed-cats"); }
  function pickedCat() {
    var on = catBox().querySelector(".chip.on");
    return on ? on.dataset.cat : "math";
  }
  function setCat(c) {
    catBox().querySelectorAll(".chip").forEach(function (b) {
      b.classList.toggle("on", b.dataset.cat === c);
    });
  }

  /* ------------------------------------------------------------------ 标签 */
  var tags = [];
  function tagList() { return tags.slice(); }
  function setTags(t) { tags = t.slice(); paintTags(); }
  function paintTags() {
    var box = $("ed-tags");
    box.querySelectorAll(".tag").forEach(function (n) { n.remove(); });
    tags.forEach(function (t, i) {
      var s = document.createElement("span");
      s.className = "tag";
      s.innerHTML = "";
      s.appendChild(document.createTextNode(t));
      var x = document.createElement("button");
      x.type = "button";
      x.className = "x";
      x.textContent = "×";
      x.title = "去掉这个标签";
      x.onclick = function () { tags.splice(i, 1); paintTags(); touched(); };
      s.appendChild(x);
      box.insertBefore(s, $("tag-input"));
    });
  }

  /* ------------------------------------------------------------------ 校验 */
  function problems() {
    var c = current(), out = [];
    if (!c.meta.title) out.push("标题不能空");
    if (!DATERE.test(c.meta.date)) out.push("日期要写成 2026-10-31 这样");
    else {
      var d = new Date(c.meta.date + "T00:00");
      if (isNaN(d.getTime())) out.push("这个日期不存在");
    }
    if (!SLUGRE.test(c.meta.slug)) out.push("地址名只能用小写字母、数字和连字符，2–80 位");
    if (!c.meta.sub) out.push("摘要不能空（列表页那一行就是它）");
    return out;
  }

  function validate() {
    if (MODE === "work") return validateWork();
    if (MODE === "plan") return validatePlan();
    return validateNote();
  }

  function validateNote() {
    var bad = problems();
    $("ed-publish").disabled = bad.length > 0;
    $("ed-why").textContent = bad.length ? bad.join("；") : "";
    $("ed-why").hidden = !bad.length;
    return bad;
  }

  /* ------------------------------------------------------------------ 预览 */
  function schedulePreview() {
    clearTimeout(tPreview);
    tPreview = setTimeout(previewNow, 450);
  }

  function previewNow() {
    if (!state.key) return;
    api("/api/render", { method: "POST", body: JSON.stringify({ body: bodyText() }) })
      .then(function (j) {
        preview.innerHTML = j.html;
        if (window.renderMathInElement) {
          renderMathInElement(preview, {
            delimiters: [{ left: "\\[", right: "\\]", display: true },
                         { left: "\\(", right: "\\)", display: false }],
            ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
            throwOnError: false, output: "htmlAndMathml"
          });
        }
      })
      .catch(function (e) { if (e.status !== 401) preview.innerHTML = '<p class="note">预览失败：' + esc(e.message) + "</p>"; });
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ------------------------------------------------------------------ 草稿 */
  function scheduleDraft() {
    clearTimeout(tDraft);
    tDraft = setTimeout(saveDraft, 1200);
  }

  function saveDraft(quiet) {
    var c = current();
    if (MODE !== "note") return Promise.resolve();
    if (!state.key || !SLUGRE.test(c.slug)) return Promise.resolve();
    var md = serialize(c);
    return api("/api/draft", { method: "POST", body: JSON.stringify({ slug: c.slug, md: md }) })
      .then(function () {
        state.drafts[c.slug] = Date.now();
        /* 草稿落盘了就不算"没存"，别在离开时拦人；只有没 slug 或存失败才拦 */
        state.dirty = false;
        if (!quiet) say("草稿已存进本机（仓库外）", "ok");
        paintList();
      })
      .catch(function (e) { if (!quiet) say("草稿没存上：" + e.message, "bad"); });
  }

  function serialize(c) {
    return "---\ntitle: " + c.meta.title + "\ndate: " + c.meta.date + "\ncat: " + c.meta.cat +
      "\ntags: [" + c.meta.tags.join(", ") + "]\nsub: " + c.meta.sub + "\nslug: " + c.meta.slug +
      "\n---\n\n" + c.body.trim() + "\n";
  }

  function touched() {
    if (loading) return;
    state.dirty = true;
    validate();
    schedulePreview();
    scheduleDraft();
  }

  /* ------------------------------------------------------------------ 列表 */
  function paintList() {
    var box = list;
    box.innerHTML = "";
    state.notes.forEach(function (n) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "editem" + (n.slug === state.slug ? " on" : "");
      var has = state.drafts[n.slug];
      b.innerHTML = '<span class="t"></span><span class="m">' + esc(n.date.slice(5)) +
        (has ? ' <b class="d">草稿</b>' : "") + "</span>";
      b.querySelector(".t").textContent = n.title;
      b.title = "/" + n.slug + "/";
      b.onclick = function () { open(n.slug); };
      box.appendChild(b);
    });
    $("ed-count").textContent = state.notes.length + " 条";
  }

  function open(slug) {
    var c = current();
    var keep = state.slug && (c.meta.title || c.body) && state.dirty;
    var go = function () {
      api("/api/note?slug=" + encodeURIComponent(slug)).then(function (j) {
        var p = parseMd(j.md);
        state.slug = slug;
        fill(p.meta, p.body);
        return api("/api/draft?slug=" + encodeURIComponent(slug)).then(function (d) {
          var pp = parseMd(d.md);
          if (d.savedAt > j.mtime) { fill(pp.meta, pp.body); say("载入的是本机草稿（比线上新）", "warn"); }
        }, function () { });
      }).then(function () {
        validate();
        previewNow();
        paintList();
        stat();
      }).catch(function (e) { say("打不开这条：" + e.message, "bad"); });
    };
    if (keep) {
      ask("当前这条还没存，切换会丢掉改动？", { ok: "丢掉", cancel: "留下" }).then(function (y) {
        if (y) { state.slug = slug; fresh(); go(); }
      });
    } else go();
  }

  function fresh() {
    state.slug = null;
    fill({ title: "", date: today(), cat: "math", sub: "", slug: "", tags: [] }, "");
    preview.innerHTML = '<p class="note">左边写字，这里就是线上样子。</p>';
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  /* ------------------------------------------------------------------ 工具条 */
  function wrap(before, after, placeholder) {
    if (!ed) return;
    ed.wrap(before, after, placeholder);
    touched();
  }
  function block(before, body, after) {
    if (!ed) return;
    ed.block(before, body, after);
    touched();
  }
  function prefix(p) {
    if (!ed) return;
    ed.prefixLines(p);
    touched();
  }

  var B = String.fromCharCode(92);   /* 反斜杠，公式里要用 */
  var TOOLS = [
    { k: "B", t: "加粗", run: function () { wrap("**", "**", "粗体"); } },
    { k: "I", t: "斜体", run: function () { wrap("_", "_", "斜体"); } },
    { k: "Tt", t: "行内代码", run: function () { wrap("`", "`", "code"); } },
    { k: "▤", t: "代码块", run: function () { block("\n```cpp\n", "// 代码\n", "```\n"); } },
    { k: "∑", t: "行内公式", run: function () { wrap("$", "$", "A v = " + B + "lambda v"); } },
    { k: "≡", t: "整段公式", run: function () { block("\n$$\n", "Q^{" + B + "T}AQ = " + B + "Lambda", "\n$$\n"); } },
    { k: "↗", t: "链接", run: function () { wrap("[", "](https://)", "文字"); } },
    { k: "❞", t: "引用", run: function () { prefix("> "); } },
    { k: "•", t: "无序列表", run: function () { prefix("- "); } },
    { k: "1.", t: "有序列表", run: function () { prefix("1. "); } },
    { k: "▦", t: "表格骨架", run: function () { block("\n| 列 | 列 | 列 |\n|---|---|---|\n| ", "a | b | c", " |\n"); } },
    { k: "▣", t: "图片（先传到仓库 assets/）", run: function () { wrap("![", "](/assets/)", "说明"); } }
  ];

  function paintTools() {
    var box = $("ed-tools");
    TOOLS.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = t.k;
      b.title = t.t;
      b.onclick = t.run;
      box.appendChild(b);
    });
  }

  /* ------------------------------------------------------------------ 发布 */
  function publish() {
    var bad = validate();
    if (bad.length) { say(bad.join("；"), "bad"); return; }
    var c = current();
    var isNew = state.notes.every(function (n) { return n.slug !== c.slug; });
    say("");
    ask("发布「" + c.meta.title + "」？" + (isNew ? "这是新建。" : "") + "会提交并推送到线上。",
        { ok: "发布", cancel: "先不" }).then(function (y) {
      if (!y) return;
      $("ed-publish").disabled = true;
      setStatus("发布中…");
      api("/api/publish", { method: "POST", body: JSON.stringify(c) }).then(function (r) {
        setStatus("已发布 " + r.sha, "ok");
        say(r.unchanged ? "内容没变化，没有产生新提交。"
            : "已提交 " + r.sha + " 并推送。约 1–2 分钟后线上可见：" + r.url, "ok");
        state.dirty = false;
        api("/api/draft?slug=" + encodeURIComponent(c.slug), { method: "DELETE" }).catch(function () { });
        return reloadNotes().then(paintList);
      }).catch(function (e) {
        setStatus("发布没成功", "bad");
        say(e.message, "bad");
      }).then(function () { $("ed-publish").disabled = false; validate(); });
    });
  }

  function reloadNotes() {
    return api("/api/notes").then(function (j) {
      state.notes = j.notes;
      state.drafts = {};
      (j.drafts || []).forEach(function (d) { state.drafts[d.slug] = d.savedAt; });
    });
  }

  /* ------------------------------------------------------------------ 解锁 */
  function connect(key) {
    state.key = key;
    return api("/api/notes").then(function (j) {
      state.notes = j.notes;
      state.drafts = {};
      (j.drafts || []).forEach(function (d) { state.drafts[d.slug] = d.savedAt; });
      setStatus("本机服务 · 已连上", "ok");
      $("ed-shell").hidden = false;
      $("ed-lock").hidden = true;
      paintList();
    });
  }

  function showLock(why) {
    $("ed-lock").hidden = false;
    $("ed-shell").hidden = true;
    $("ed-lockmsg").textContent = why || "";
  }

  function askKey(prefill) {
    askText("连接本机服务", "输入 sitekeeper 启动时打印的口令（只存这台电脑）",
            { ok: "连接", password: true, value: prefill || "" }).then(function (r) {
      if (!r.ok) { showLock("没填口令，只能看不能改。"); return; }
      try { localStorage.setItem(KEYNAME, r.value); } catch (e) {}
      connect(r.value).catch(function (e) {
        try { localStorage.removeItem(KEYNAME); } catch (_) {}
        state.key = null;
        showLock(e.status === 401 ? "口令不对。"
                                 : "连不上 127.0.0.1:8720 —— 双击 sitekeeper\\start.cmd 再试。");
      });
    });
  }

  function unlock() {
    var saved = null;
    try { saved = localStorage.getItem(KEYNAME); } catch (e) {}
    if (saved) {
      connect(saved).catch(function (e) {
        try { localStorage.removeItem(KEYNAME); } catch (_) {}
        state.key = null;
        showLock(e.status === 401 ? "存的口令已经不作数了。" : "连不上本机服务。");
      });
    } else showLock("");
  }

  /* ========================= 作品与日程：另一种表单 ================ */
  var MODE = "note";
  var $all = function (sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); };
  var WFIELDS = ["state", "name", "href", "desc", "stack"];
  var WLIMIT = {state: 12, name: 60, href: 300, desc: 200, stack: 40};
  var WNAME = {state: "状态", name: "名称", href: "链接", desc: "说明", stack: "栈"};
  var DKEY = {work: "lab-ed-work-draft-v1", plan: "lab-ed-plan-draft-v1"};
  var cache = {work: null, plan: null};    /* 线上版本，DOM 里是当前编辑 */
  var secRefs = {};
  var tRowDraft = null, tPlanDraft = null, planTimer = null;
  var TSRE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

  function keepLocal(type, data, revertBtn) {
    writeLocal(DKEY[type], data);
    $(revertBtn).hidden = false;
    say("存在这台电脑上（浏览器本地），没有提交。", "ok");
  }

  function readLocal(k) {
    try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function writeLocal(k, v) {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }

  function setMode(m) {
    if (m === MODE) return;
    MODE = m;
    $all("#ed-modes .chip").forEach(function (b) { b.classList.toggle("on", b.dataset.mode === m); });
    $("pane-note").hidden = m !== "note";
    $("pane-work").hidden = m !== "work";
    $("pane-plan").hidden = m !== "plan";
    $("ed-tools").hidden = m !== "note";
    $("ed-row").hidden = m !== "note";
    $("ed-stat").hidden = m !== "note";
    $("ed-grid").hidden = m !== "work";
    $("ed-alt").hidden = m !== "plan";
    $("ed-draft").hidden = m !== "note";
    say("");
    if (m === "work") loadWork();
    if (m === "plan") { loadPlan(); planTick(); }
    if (m === "note") stat();
    clearInterval(planTimer);
    planTimer = m === "plan" ? setInterval(planTick, 1000) : null;
    validate();
  }

  /* ------------------------------------------------------------------ 作品 */
  var notified = {};

  function loadWork() {
    var local = readLocal(DKEY.work);
    if (local) {                       /* 本机编辑优先，切来切去不能把它冲掉 */
      paintWork(local);
      $("w-revert").hidden = false;
      if (cache.work && JSON.stringify(local) !== JSON.stringify(cache.work) && !notified.work) {
        notified.work = true;
        say("载入的是这台电脑上没发布的改动（线上是另一版）。", "warn");
      }
      return;
    }
    if (cache.work) {
      paintWork(cache.work);
      $("w-revert").hidden = true;
      return;
    }
    api("/api/work").then(function (j) {
      cache.work = j.data;
      loadWork();
    }).catch(function (e) { say("读不出作品：" + e.message, "bad"); });
  }

  function rowEl(sec, it) {
    var tr = document.createElement("div");
    tr.className = "g-r";
    tr.dataset.sec = sec;
    WFIELDS.forEach(function (k) {
      var inp = document.createElement("input");
      inp.type = "text";
      inp.dataset.k = k;
      inp.value = it[k] || "";
      inp.spellcheck = false;
      inp.title = WNAME[k] + "（上限 " + WLIMIT[k] + " 字）";
      inp.addEventListener("input", rowTouched);
      tr.appendChild(inp);
    });
    var ops = document.createElement("div");
    ops.className = "g-ops";
    [["↑", "上移", function () { moveRow(tr, -1); }],
     ["↓", "下移", function () { moveRow(tr, 1); }],
     ["×", "删掉这一行", function () { tr.parentNode.removeChild(tr); rowTouched(); }]]
      .forEach(function (o) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = o[0];
        b.title = o[1];
        b.onclick = o[2];
        ops.appendChild(b);
      });
    tr.appendChild(ops);
    return tr;
  }

  function paintWork(d) {
    var g = $("ed-grid");
    g.innerHTML = "";
    secRefs = {};
    [["open", "在写的", "在写"], ["closed", "停掉的", "已停"]].forEach(function (sec) {
      var bar = document.createElement("div");
      bar.className = "g-sec";
      var label = document.createElement("span");
      label.textContent = sec[1];
      var add = document.createElement("button");
      add.type = "button";
      add.className = "g-add";
      add.textContent = "＋ 加一行";
      add.onclick = function () { insertRow(sec[0], {state: sec[2], name: "", href: "【仓库链接】", desc: "", stack: ""}); };
      bar.appendChild(label);
      bar.appendChild(add);
      g.appendChild(bar);

      var head = document.createElement("div");
      head.className = "g-h";
      head.innerHTML = "<span>状态</span><span>名称</span><span>链接</span><span>说明</span><span>栈</span><span>操作</span>";
      g.appendChild(head);
      secRefs[sec[0]] = head;
      (d[sec[0]] || []).forEach(function (it) { g.appendChild(rowEl(sec[0], it)); });
    });
    validateWork();
  }

  function insertRow(sec, blank) {
    var rows = $all('#ed-grid .g-r[data-sec="' + sec + '"]');
    var el = rowEl(sec, blank);
    if (rows.length) {
      var last = rows[rows.length - 1];
      last.parentNode.insertBefore(el, last.nextSibling);
    } else {
      $("ed-grid").insertBefore(el, secRefs[sec].nextSibling);
    }
    rowTouched();
    el.querySelector('[data-k="name"]').focus();
  }

  function moveRow(el, dir) {
    var rows = $all('#ed-grid .g-r[data-sec="' + el.dataset.sec + '"]');
    var i = rows.indexOf(el), j = i + dir;
    if (j < 0 || j >= rows.length) return;
    if (dir < 0) el.parentNode.insertBefore(el, rows[j]);
    else el.parentNode.insertBefore(rows[j], el);
    rowTouched();
  }

  function collectWork() {
    var out = {open: [], closed: []};
    $all("#ed-grid .g-r").forEach(function (tr) {
      var o = {};
      WFIELDS.forEach(function (k) {
        o[k] = tr.querySelector('[data-k="' + k + '"]').value.trim();
      });
      out[tr.dataset.sec].push(o);
    });
    return out;
  }

  function validateWork() {
    var d = collectWork(), bad = [];
    if (!d.open.length) bad.push("在写的至少留一行");
    [["open", "在写"], ["closed", "停掉"]].forEach(function (sec) {
      d[sec[0]].forEach(function (it, i) {
        WFIELDS.forEach(function (k) {
          var v = it[k];
          if (!v) bad.push(sec[1] + " 第 " + (i + 1) + " 行的" + WNAME[k] + "是空的");
          else if (v.length > WLIMIT[k])
            bad.push(sec[1] + " 第 " + (i + 1) + " 行的" + WNAME[k] + "有 " + v.length + " 字，上限 " + WLIMIT[k]);
        });
      });
    });
    $all("#ed-grid .g-r input").forEach(function (inp) {
      var v = inp.value.trim();
      inp.classList.toggle("bad", !v || v.length > WLIMIT[inp.dataset.k]);
    });
    $("w-count").textContent = d.open.length + " · " + d.closed.length + " 行";
    $("ed-publish").disabled = bad.length > 0;
    $("ed-why-w").textContent = bad.length > 4 ? bad.slice(0, 4).join("；") + "…（共 " + bad.length + " 处）"
                                               : bad.join("；");
    $("ed-why-w").hidden = !bad.length;
    return bad;
  }

  function rowTouched() {
    validateWork();
    clearTimeout(tRowDraft);
    tRowDraft = setTimeout(function () {
      writeLocal(DKEY.work, collectWork());
      $("w-revert").hidden = false;
    }, 700);
  }

  /* ------------------------------------------------------------------ 日程 */
  function loadPlan() {
    var local = readLocal(DKEY.plan);
    if (local) {
      fillPlan(local);
      $("p-revert").hidden = false;
      if (cache.plan && JSON.stringify(local) !== JSON.stringify(cache.plan) && !notified.plan) {
        notified.plan = true;
        say("载入的是这台电脑上没发布的日程。", "warn");
      }
      return;
    }
    if (cache.plan) {
      fillPlan(cache.plan);
      $("p-revert").hidden = true;
      return;
    }
    api("/api/plan").then(function (j) {
      cache.plan = j.data;
      loadPlan();
    }).catch(function (e) { say("读不出日程：" + e.message, "bad"); });
  }

  function fillPlan(d) {
    $("p-label").value = d.label || "";
    $("p-target").value = d.target || "";
    validatePlan();
    planTick();
  }

  function collectPlan() {
    return {label: $("p-label").value.trim(), target: $("p-target").value.trim()};
  }

  function planDate(s) {
    var m = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    var ok = d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] &&
             d.getHours() === +m[4] && d.getMinutes() === +m[5];
    return ok ? d : null;
  }

  function validatePlan() {
    var o = collectPlan(), bad = [];
    if (!o.label) bad.push("名称不能空");
    else if (o.label.length > 12) bad.push("名称有 " + o.label.length + " 字，上限 12");
    if (!TSRE.test(o.target)) bad.push("时间要写成 2027-01-01 00:00 这样");
    else if (!planDate(o.target)) bad.push("这个日期不存在");
    $("p-label").classList.toggle("bad", !o.label || o.label.length > 12);
    $("p-target").classList.toggle("bad", !TSRE.test(o.target) || !planDate(o.target));
    $("ed-publish").disabled = bad.length > 0;
    $("ed-why-p").textContent = bad.join("；");
    $("ed-why-p").hidden = !bad.length;
    return bad;
  }

  function planTouched() {
    validatePlan();
    planTick();
    clearTimeout(tPlanDraft);
    tPlanDraft = setTimeout(function () {
      writeLocal(DKEY.plan, collectPlan());
      $("p-revert").hidden = false;
    }, 700);
  }

  function cell(big, small) {
    var d = document.createElement("div");
    d.className = "u";
    var b = document.createElement("b");
    b.className = "mono";
    b.textContent = big;
    var s = document.createElement("span");
    s.textContent = small;
    d.appendChild(b);
    d.appendChild(s);
    return d;
  }

  function planTick() {
    if (MODE !== "plan") return;
    var o = collectPlan(), d = TSRE.test(o.target) ? planDate(o.target) : null;
    var box = $("alt-pv");
    box.innerHTML = "";
    if (!d) {
      var p = document.createElement("p");
      p.className = "note";
      p.textContent = "时间没填对，预览不出来。";
      box.appendChild(p);
      $("p-count").textContent = "—";
      return;
    }
    var ms = d - new Date(), over = ms <= 0, abs = Math.abs(ms);
    var days = Math.floor(abs / 864e5);
    var row = document.createElement("div");
    row.className = "clock";
    row.appendChild(cell(days, o.label || "目标"));
    if (!over) {
      row.appendChild(cell(pad(Math.floor(abs / 36e5) % 24), "时"));
      row.appendChild(cell(pad(Math.floor(abs / 6e4) % 60), "分"));
      row.appendChild(cell(pad(Math.floor(abs / 1e3) % 60), "秒"));
    }
    box.appendChild(row);
    var line = document.createElement("p");
    line.className = "note";
    line.textContent = over ? "已经过了 " + days + " 天：首页会藏掉时分秒，只留“已过 N 天”。"
                            : "首页那一行就是这四个格子，所有人打开都是这一个日期。";
    box.appendChild(line);
    var src = document.createElement("p");
    src.className = "alt-src";
    src.textContent = "烘进 index.html：" + JSON.stringify(o);
    box.appendChild(src);
    $("p-count").textContent = over ? "已过 " + days + " 天" : "还有 " + days + " 天";
  }

  /* ------------------------------------------------------------ 发布（表单） */
  function publishRows(type, data, what) {
    var bad = type === "work" ? validateWork() : validatePlan();
    if (bad.length) { say(bad.join("；"), "bad"); return; }
    say("");
    ask("发布" + what + "？会提交并推送到线上。", { ok: "发布", cancel: "先不" }).then(function (y) {
      if (!y) return;
      $("ed-publish").disabled = true;
      setStatus("发布中…");
      api("/api/publish", { method: "POST", body: JSON.stringify({type: type, data: data}) })
        .then(function (r) {
          setStatus("已发布 " + r.sha, "ok");
          say(r.unchanged ? "内容没变化，没有产生新提交。"
                          : "已提交 " + r.sha + " 并推送。约 1–2 分钟后线上可见：" + r.url, "ok");
          cache[type] = data;
          writeLocal(DKEY[type], null);
          $(type === "work" ? "w-revert" : "p-revert").hidden = true;
          if (type === "work") paintWork(data);
        })
        .catch(function (e) { setStatus("发布没成功", "bad"); say(e.message, "bad"); })
        .then(function () { $("ed-publish").disabled = false; validate(); });
    });
  }

  /* ---------------------------------------------------------------- 分隔条 */
  var RKEY = "lab-ed-split";
  function pvCol() { return document.querySelector(".ed-pv"); }
  function ratio() {
    var row = document.querySelector(".ed-row").getBoundingClientRect();
    var r = f.body.getBoundingClientRect();
    return row.width ? (r.left - row.left + r.width) / row.width : 0.5;
  }
  function setRatio(r) {
    r = Math.min(0.82, Math.max(0.18, r));
    f.body.style.flex = "1 1 " + (r * 100).toFixed(2) + "%";
    pvCol().style.flex = "1 1 " + ((1 - r) * 100).toFixed(2) + "%";
    try { localStorage.setItem(RKEY, String(r)); } catch (e) {}
  }
  function resetRatio() {
    f.body.style.flex = "";
    pvCol().style.flex = "";
    try { localStorage.removeItem(RKEY); } catch (e) {}
  }
  function setupSplit() {
    var bar = $("ed-split"), drag = false;
    var saved = null;
    try { saved = parseFloat(localStorage.getItem(RKEY)); } catch (e) {}
    if (saved > 0.18 && saved < 0.82) setRatio(saved);
    bar.addEventListener("pointerdown", function (e) {
      drag = true;
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    bar.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var row = document.querySelector(".ed-row").getBoundingClientRect();
      setRatio((e.clientX - row.left) / row.width);
    });
    bar.addEventListener("pointerup", function (e) {
      drag = false;
      try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    bar.addEventListener("pointercancel", function () { drag = false; });
    bar.addEventListener("dblclick", resetRatio);
    bar.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { e.preventDefault(); setRatio(ratio() - 0.05); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setRatio(ratio() + 0.05); }
      else if (e.key === "Enter") { e.preventDefault(); resetRatio(); }
    });
  }

  /* 窗口窄到放不下两栏时，换成一个切换按钮 */
  function setupPvToggle() {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "ed-only";
    b.textContent = "预览";
    b.onclick = function () {
      var on = document.body.classList.toggle("ed-showpv");
      b.textContent = on ? "正文" : "预览";
      if (on) previewNow();
    };
    $("ed-tools").appendChild(b);
  }

  /* ---------------------------------------------------------------- 状态行 */
  function stat(c) {
    if (!ed) return;
    c = c || ed.cursor();
    var v = bodyText();
    var lines = v.split("\n").length;
    var blocks = (v.match(/^\s{0,3}(#{2,3}\s|>\s|-{3,}\s|\|)/gm) || []).length;
    var math = (v.match(/\$\$/g) || []).length >> 1;
    $("ed-stat").textContent = "第 " + c.line + " 行 第 " + c.col + " 列 · " + v.length +
      " 字符 · " + lines + " 行 · 整段公式 " + math + " 处";
  }

  /* ------------------------------------------------------------------ 装配 */
  function boot() {
    $("ed-cats").querySelectorAll(".chip").forEach(function (b) {
      b.onclick = function () { setCat(b.dataset.cat); touched(); };
    });
    $all("#ed-modes .chip").forEach(function (b) {
      b.onclick = function () { setMode(b.dataset.mode); };
    });
    ["p-label", "p-target"].forEach(function (id) {
      $(id).addEventListener("input", planTouched);
      $(id).addEventListener("change", planTouched);
    });
    $("btn-plan").onclick = function () {
      var o = collectPlan(), d = TSRE.test(o.target) ? planDate(o.target) : new Date();
      window.datePicker($("btn-plan"), {value: d, onPick: function (p) {
        $("p-target").value = p.getFullYear() + "-" + pad(p.getMonth() + 1) + "-" + pad(p.getDate()) +
                              " " + pad(p.getHours()) + ":" + pad(p.getMinutes());
        planTouched();
      }});
    };
    $("w-revert").onclick = function () {
      writeLocal(DKEY.work, null);
      $("w-revert").hidden = true;
      if (cache.work) paintWork(cache.work);
      say("回到线上版本了。", "ok");
    };
    $("p-revert").onclick = function () {
      writeLocal(DKEY.plan, null);
      $("p-revert").hidden = true;
      if (cache.plan) fillPlan(cache.plan);
      say("回到线上版本了。", "ok");
    };
    paintTools();
    paintTags();
    setupSplit();
    setupPvToggle();

    ["title", "date", "sub", "slug"].forEach(function (k) {
      f[k].addEventListener("input", touched);
    });
    f.date.addEventListener("change", touched);

    /* 正文交给 CodeMirror：行号槽在软换行时也不会错位，这是自己拼做不到的 */
    if (window.LabEditor) {
      ed = window.LabEditor.create(f.body, {
        doc: "",
        placeholder: "正文写 Markdown，公式用 $...$ 或 $$...$$",
        onChange: function () { touched(); },
        onCursor: function (c) { stat(c); }
      });
    } else {
      stat();
    }
    $("btn-date").onclick = function () {
      var v = DATERE.test(f.date.value) ? new Date(f.date.value + "T09:00") : new Date();
      window.datePicker($("btn-date"), { value: v, onPick: function (p) {
        f.date.value = p.getFullYear() + "-" + pad(p.getMonth() + 1) + "-" + pad(p.getDate());
        touched();
      } });
    };
    $("tag-input").addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      var v = this.value.trim();
      if (v && tags.indexOf(v) < 0) { tags.push(v); paintTags(); touched(); }
      this.value = "";
    });
    $("ed-new").onclick = function () { fresh(); state.dirty = false; validate(); paintList(); f.title.focus(); };
    $("ed-draft").onclick = function () { saveDraft(false); };
    $("ed-publish").onclick = function () {
      if (MODE === "work") publishRows("work", collectWork(), "作品的两张表");
      else if (MODE === "plan") publishRows("plan", collectPlan(), "首页倒数日");
      else publish();
    };
    $("ed-retry").onclick = function () {
      var saved = null;
      try { saved = localStorage.getItem(KEYNAME); } catch (e) {}
      askKey(saved || "");
    };
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (MODE === "work") keepLocal("work", collectWork(), "w-revert");
        else if (MODE === "plan") keepLocal("plan", collectPlan(), "p-revert");
        else saveDraft(false);
      }
    });
    window.addEventListener("beforeunload", function (e) {
      if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
    });

    fresh();
    validate();
    unlock();

    var want = null;
    try { want = new URLSearchParams(location.search).get("slug"); } catch (e) {}
    if (want) {
      var wait = function () {
        if (!state.key) return setTimeout(wait, 200);
        open(want);
      };
      wait();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
