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
    pdf: $("f-pdf"), body: $("f-body")
  };
  var ed = null;                       /* CodeMirror 实例 */
  function bodyText() { return ed ? ed.getValue() : ""; }
  function setBody(t) { if (ed) ed.setValue(t); }
  var list = $("ed-list"), status = $("ed-status"), msg = $("ed-msg"), preview = $("ed-preview");
  var SORTKEY = "lab-ed-sort";
  var state = { notes: [], drafts: {}, forms: [], uploads: [], images: [], onlineMd: null, slug: null, key: null, dirty: false,
                draftKey: null, origSlug: null, shown: {}, tried: false, offline: false, savedAt: 0,
                sort: (function () { try { return localStorage.getItem(SORTKEY) || "date"; } catch (e) { return "date"; } })() };
  var tDraft = null, tPreview = null;

  /* ---------------------------------------------------------------- 服务调用 */
  function api(path, opt) {
    opt = opt || {};
    opt.headers = { "Content-Type": "application/json", "X-Lab-Key": state.key || "" };
    return fetch(BASE + path, opt).catch(function (e) {
      /* 连接层失败（服务关了、端口不对）和 4xx/5xx 分开：前者不该清口令 */
      var err = new Error("连不上本机服务");
      err.status = 0;
      err.offline = true;
      if (state.connected) goOffline();
      throw err;
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var err = new Error(j.error || j.why || ("HTTP " + r.status));
          err.status = r.status;
          err.step = j.step || "";
          throw err;
        }
        if (typeof j === "object" && j) state.offline = false;
        return j;
      });
    });
  }

  /* ------------------------------------------------- 服务掉线：不锁页，后台等它回来 */
  var tPoll = null, pollGen = 0;
  function goOffline() {
    if (state.offline) return;
    state.offline = true;
    setStatus("本机服务断了 · 等它回来", "bad");
    say("本机服务断了。可以接着写，改动先留在页面里；服务回来会自动补存草稿。", "warn");
    poll(function () {
      state.offline = false;
      setStatus("本机服务 · 已连上", "ok");
      say("服务回来了。", "ok");
      if (MODE === "note" && state.dirty) saveDraft(true);
      gitstat();
    });
  }

  /* 同一时间只留一条探测链：新的一开，旧的那条下次醒来就自己退出 */
  function poll(onUp, gen) {
    if (gen === undefined) { clearTimeout(tPoll); gen = ++pollGen; }
    if (gen !== pollGen) return;
    fetch(BASE + "/ping", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw 0;
      if (gen === pollGen) onUp();
    }).catch(function () {
      if (gen === pollGen) tPoll = setTimeout(function () { poll(onUp, gen); }, 3000);
    });
  }

  function setStatus(text, cls) {
    status.textContent = text;
    status.className = "passcount" + (cls ? " " + cls : "");
  }

  /* acts: [["按钮字", fn], ...]；link: {href, text} —— 提示行里可以带动作和链接 */
  var tSay = null;
  function say(text, kind, acts, link) {
    clearTimeout(tSay);
    msg.textContent = text || "";
    msg.className = "ed-msg" + (kind ? " " + kind : "");
    if (link) {
      var a = document.createElement("a");
      a.href = link.href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = link.text || link.href;
      msg.appendChild(document.createTextNode(" "));
      msg.appendChild(a);
    }
    (acts || []).forEach(function (x) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "mini";
      b.textContent = x[0];
      b.onclick = function () { say(""); x[1](); };
      msg.appendChild(document.createTextNode(" "));
      msg.appendChild(b);
    });
    msg.hidden = !text;
  }
  function sayFor(ms, text, kind, acts) {
    say(text, kind, acts);
    tSay = setTimeout(function () { say(""); }, ms);
  }

  /* ---------------------------------------------------- 仓库状态：未推/脏/草稿 */
  function gitstat() {
    var box = $("ed-git");
    if (!box || !state.key) return;
    api("/api/status").then(function (j) {
      var dirty = j.dirty || [];
      var ahead = parseInt(j.ahead, 10);
      var drafts = Object.keys(state.drafts).length + state.forms.length;
      var parts = [
        ["分支 " + (j.branch || "?"), ""],
        ["未推 " + (isNaN(ahead) ? "?" : ahead), ahead > 0 ? "warn" : "ok"],
        ["脏 " + dirty.length, dirty.length ? "bad" : "ok"],
        ["草稿 " + drafts, drafts ? "warn" : "ok"]
      ];
      if (state.uploads.length) parts.push(["待发 PDF " + state.uploads.length, "warn"]);
      if ((state.images || []).length) parts.push(["待发图片 " + state.images.length, "warn"]);
      box.innerHTML = "";
      parts.forEach(function (p) {
        var s = document.createElement("span");
        s.className = "gk" + (p[1] ? " " + p[1] : "");
        s.textContent = p[0];
        box.appendChild(s);
      });
      box.title = (dirty.length ? "未提交的改动：\n" + dirty.join("\n") : "工作区干净") +
        (state.uploads.length ? "\n\n已上传、等发布的 PDF：\n" + state.uploads.map(function (u) { return u.path; }).join("\n") : "");
      box.hidden = false;
    }).catch(function () { /* 取不到就整行不显示，不拿假数字糊人 */ });
  }

  /* ------------------------------------------------------------ md <-> 字段 */
  function parseMd(md) {
    var m = /^---\n([\s\S]*?)\n---\n?/.exec(md || "");
    var meta = { title: "", date: "", cat: "cs", sub: "", slug: "", pdf: "", tags: [] };
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
        sub: oneLine(f.sub.value), slug: f.slug.value.trim(), pdf: f.pdf.value.trim(), tags: tagList()
      },
      body: bodyText()
    };
  }

  function oneLine(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

  function fill(meta, body) {
    loading = true;
    f.title.value = meta.title || "";
    f.date.value = meta.date || "";
    f.sub.value = meta.sub || "";
    f.slug.value = meta.slug || "";
    f.pdf.value = meta.pdf || "";
    setBody(body || "");
    setCat(meta.cat || "math");
    setTags(meta.tags || []);
    $("tag-input").value = "";
    loading = false;
    pdfInfo();
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
  /* 输入框里打了还没回车的那个也算，发布时不能悄悄丢掉 */
  function tagList() {
    var out = tags.slice(), v = cleanTag($("tag-input").value);
    if (v && out.indexOf(v) < 0) out.push(v);
    return out;
  }
  function cleanTag(s) { return oneLine(String(s || "").replace(/[,，、]/g, " ")); }
  function commitTag() {
    var inp = $("tag-input"), parts = inp.value.split(/[,，、]/), changed = false;
    parts.forEach(function (p) {
      var v = cleanTag(p);
      if (v && tags.indexOf(v) < 0) { tags.push(v); changed = true; }
    });
    inp.value = "";
    if (changed) { paintTags(); touched(); }
  }
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
    var add = function (k, m) { out.push({ k: k, m: m }); };
    if (!c.meta.title) add("title", "标题不能空");
    if (!DATERE.test(c.meta.date)) add("date", "日期要写成 2026-10-31 这样");
    else {
      var p = c.meta.date.split("-"), d = new Date(+p[0], +p[1] - 1, +p[2]);
      if (d.getMonth() !== +p[1] - 1 || d.getDate() !== +p[2]) add("date", "这个日期不存在");
    }
    if (!SLUGRE.test(c.meta.slug)) add("slug", "地址名只能用小写字母、数字和连字符，2–80 位");
    else if (c.meta.slug !== state.origSlug &&
             state.notes.some(function (n) { return n.slug === c.meta.slug; }))
      add("slug", "地址名 " + c.meta.slug + " 已经被另一条笔记用了");
    if (!c.meta.sub) add("sub", "摘要不能空（列表页那一行就是它）");
    return out;
  }

  function validate() {
    if (MODE === "work") return validateWork();
    if (MODE === "plan") return validatePlan();
    return validateNote();
  }

  /* 没碰过的字段不急着报红：失焦过、或者点过发布，才显示那一项的问题。
     发布按钮只在没连上时禁用，点了会把剩下的问题一次说清。 */
  function validateNote() {
    var all = problems(), seen = all.filter(function (p) { return state.tried || state.shown[p.k]; });
    ["title", "date", "sub", "slug"].forEach(function (k) {
      f[k].classList.toggle("bad", seen.some(function (p) { return p.k === k; }));
    });
    $("ed-publish").disabled = !state.key;
    $("ed-why").textContent = seen.map(function (p) { return p.m; }).join("；");
    $("ed-why").hidden = !seen.length;
    return all.map(function (p) { return p.m; }).concat(state.key ? [] : ["没连上本机服务"]);
  }

  /* ------------------------------------------------------------------ 预览 */
  function schedulePreview() {
    clearTimeout(tPreview);
    tPreview = setTimeout(previewNow, 450);
  }

  function previewNow() {
    if (pvTab === "diff") showChanges();
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
        fixPreviewImages();
        syncFrom("ed");
      })
      .catch(function (e) { if (e.status !== 401) preview.innerHTML = '<p class="note">预览失败：' + esc(e.message) + "</p>"; });
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ------------------------------------------------------------------ 草稿 */
  function scheduleDraft() {
    clearTimeout(tDraft);
    tDraft = setTimeout(function () { saveDraft(true); }, 1200);
  }

  /* 草稿存在哪个名字下：已发布的笔记一直用它原来的地址名（改地址也不换），
     新建的用当前地址名；地址名边打边变时，把上一个半截名字的草稿删掉，不留孤儿。 */
  function draftKeyNow(c) {
    if (state.origSlug) return state.origSlug;
    return SLUGRE.test(c.slug) ? c.slug : null;
  }

  function saveDraft(quiet) {
    clearTimeout(tDraft);
    var c = current();
    if (MODE !== "note" || !state.key || state.offline) return Promise.resolve(false);
    var key = draftKeyNow(c);
    if (!key) {
      if (!quiet) say("先填一个地址名，草稿才有地方存。", "warn");
      return Promise.resolve(false);
    }
    var md = serialize(c), prev = state.draftKey;
    return api("/api/draft", { method: "POST", body: JSON.stringify({ slug: key, md: md }) })
      .then(function () {
        if (prev && prev !== key && !isPublished(prev)) {
          api("/api/draft?slug=" + encodeURIComponent(prev), { method: "DELETE" }).catch(function () { });
          delete state.drafts[prev];
        }
        state.draftKey = key;
        state.drafts[key] = Date.now();
        state.dirty = false;
        state.savedAt = Date.now();
        if (!quiet) sayFor(2500, "草稿已存进本机（仓库外）", "ok");
        stat();
        paintList();
        gitstat();
        return true;
      })
      .catch(function (e) {
        if (!quiet || !e.offline) say("草稿没存上：" + e.message, "bad");
        return false;
      });
  }

  function isPublished(slug) {
    return state.notes.some(function (n) { return n.slug === slug; });
  }

  function dropDraft() {
    var key = state.draftKey || state.origSlug;
    if (!key) return Promise.resolve();
    delete state.drafts[key];
    state.draftKey = null;
    return api("/api/draft?slug=" + encodeURIComponent(key), { method: "DELETE" })
      .catch(function () { }).then(function () { paintList(); gitstat(); });
  }

  function serialize(c) {
    return "---\ntitle: " + c.meta.title + "\ndate: " + c.meta.date + "\ncat: " + c.meta.cat +
      "\ntags: [" + c.meta.tags.join(", ") + "]\nsub: " + c.meta.sub + "\nslug: " + c.meta.slug +
      (c.meta.pdf ? "\npdf: " + c.meta.pdf : "") +
      "\n---\n\n" + c.body.trim() + "\n";
  }

  function touched() {
    if (loading) return;
    var was = state.dirty;
    state.dirty = true;
    if (!was) stat();
    validate();
    schedulePreview();
    scheduleDraft();
  }

  /* ------------------------------------------------------------------ 列表 */
  function sortedNotes() {
    if (state.sort !== "stub") return state.notes;      /* 默认按日期，服务端已排好 */
    return state.notes.slice().sort(function (a, b) {
      return (b.stub ? 1 : 0) - (a.stub ? 1 : 0) || a.words - b.words ||
             (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
    });
  }

  function badge(box, cls, text) {
    var b = document.createElement("b");
    b.className = "d" + (cls ? " " + cls : "");
    b.textContent = text;
    box.appendChild(b);
  }

  function paintList() {
    var box = list;
    box.innerHTML = "";
    var shown = sortedNotes().filter(noteMatch);
    if (!shown.length && noteQ) {
      var none = document.createElement("p");
      none.className = "note ed-none";
      none.textContent = "没有匹配「" + noteQ + "」的笔记";
      box.appendChild(none);
    }
    shown.forEach(function (n) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "editem" + (n.slug === state.slug ? " on" : "");
      var t = document.createElement("span");
      t.className = "t";
      t.textContent = n.title;
      b.appendChild(t);

      var m = document.createElement("span");
      m.className = "m";
      m.appendChild(document.createTextNode(n.date.slice(5)));
      m.appendChild(document.createTextNode(" "));
      if (n.stub) badge(m, "stub", "待写"); else badge(m, "w", n.words + " 字");
      if (n.pdf) badge(m, "pdf", "PDF");
      if (state.drafts[n.slug]) badge(m, "draft", "草稿");
      b.appendChild(m);

      b.title = "/" + n.slug + "/" + (n.stub ? " · 正文还是占位" : "");
      b.onclick = function () { open(n.slug); };
      box.appendChild(b);
    });
    var stubs = state.notes.filter(function (n) { return n.stub; }).length;
    $("ed-count").textContent = (noteQ ? shown.length + " / " : "") + state.notes.length + " 条" +
      (stubs && !noteQ ? " · " + stubs + " 待写" : "");
    var btn = $("ed-sort");
    if (btn) {
      btn.textContent = state.sort === "stub" ? "待写优先" : "按日期";
      btn.title = state.sort === "stub" ? "现在：占位的排前面，同组内字数少的在前" : "现在：按日期新到旧";
    }
  }

  /* 离开当前这条之前：能存草稿就先存，存不了（没地址名、服务断了）才问 */
  function leave() {
    if (!state.dirty) return Promise.resolve(true);
    return saveDraft(true).then(function (ok) {
      if (ok) return true;
      var c = current();
      if (!c.meta.title && !c.body.trim()) return true;
      return ask(SLUGRE.test(c.slug) ? "草稿存不上（本机服务没连着），离开会丢掉这条的改动。"
                                     : "这一条还没填地址名，草稿没地方存，离开会丢掉改动。",
                 { ok: "丢掉", cancel: "留下" });
    });
  }

  function open(slug) {
    if (slug === state.slug) return;
    leave().then(function (go) {
      if (!go) return;
      api("/api/note?slug=" + encodeURIComponent(slug)).then(function (j) {
        var p = parseMd(j.md);
        var online = { meta: p.meta, body: p.body };
        state.onlineMd = norm(j.md);
        histFor = null;
        state.slug = slug;
        state.origSlug = slug;
        state.draftKey = null;
        state.shown = {};
        state.tried = false;
        fill(p.meta, p.body);
        lockSlug(true);
        say("");
        return api("/api/draft?slug=" + encodeURIComponent(slug)).then(function (d) {
          state.draftKey = slug;
          if (d.savedAt > j.mtime) {
            var pp = parseMd(d.md);
            fill(pp.meta, pp.body);
            if (pp.meta.slug && pp.meta.slug !== slug) lockSlug(false);
            say("载入的是本机草稿（比线上新）。", "warn", [["丢弃草稿，用线上版", function () {
              dropDraft().then(function () {
                fill(online.meta, online.body);
                lockSlug(true);
                state.dirty = false;
                validate();
                previewNow();
              });
            }]]);
          }
        }, function () { });
      }).then(function () {
        state.dirty = false;
        validate();
        previewNow();
        paintList();
        stat();
        pvMode(pvTab);
      }).catch(function (e) { say("打不开这条：" + e.message, "bad"); });
    });
  }

  function fresh() {
    state.onlineMd = null;
    histFor = null;
    state.slug = null;
    state.origSlug = null;
    state.draftKey = null;
    state.shown = {};
    state.tried = false;
    fill({ title: "", date: today(), cat: "math", sub: "", slug: "", tags: [] }, "");
    lockSlug(false);
    preview.innerHTML = '<p class="note">左边写字，这里就是线上样子。</p>';
    pvMode("md");
  }

  /* 已发布的笔记，地址名就是线上链接：默认锁住，要改得点「改地址」并确认 */
  function lockSlug(on) {
    f.slug.readOnly = on;
    f.slug.classList.toggle("ro", on);
    var b = $("btn-slug");
    b.hidden = !state.origSlug;
    b.textContent = on ? "改地址" : "还原";
    b.title = on ? "改了以后旧链接会失效" : "换回原来的地址名";
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function hhmm(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); }

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
    { k: "∑", t: "行内公式（Ctrl+M）；光标在公式里时是改它", fx: true, run: function (e) { openFx(false, e && e.currentTarget); } },
    { k: "≡", t: "整段公式（Ctrl+Shift+M）", fx: true, run: function (e) { openFx(true, e && e.currentTarget); } },
    { k: "↗", t: "链接", run: function () { wrap("[", "](https://)", "文字"); } },
    { k: "❞", t: "引用", run: function () { prefix("> "); } },
    { k: "•", t: "无序列表", run: function () { prefix("- "); } },
    { k: "1.", t: "有序列表", run: function () { prefix("1. "); } },
    { k: "▦", t: "表格骨架", run: function () { block("\n| 列 | 列 | 列 |\n|---|---|---|\n| ", "a | b | c", " |\n"); } },
    { k: "▣", t: "插入图片：选文件上传（也可以直接粘贴截图，或拖进正文）", run: function () { $("img-file").click(); } },
    { k: "§", t: "大纲：跳到某个标题", id: "outline", run: openOutline },
    { k: "⌕", t: "查找替换（Ctrl+F / Ctrl+H）", run: function () { if (ed && ed.find) ed.find(); } },
    { k: "⇅", t: "预览跟着正文滚动", id: "sync", run: toggleSync }
  ];

  function paintTools() {
    var box = $("ed-tools");
    TOOLS.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = t.k;
      b.title = t.t;
      b.onclick = t.run;
      if (t.id) b.setAttribute("data-k", t.id);
      if (t.fx) b.setAttribute("data-fx-keep", "");   /* 点它是开关面板，别被「点外面就关」抢先 */
      box.appendChild(b);
    });
  }

  /* ------------------------------------------------------------------ 公式 */
  /* 找出正文里每一处公式的位置。规则跟线上渲染（arithmatex）对齐：
     $$…$$、\[…\] 是整段，$…$、\(…\) 是行内；代码块、行内代码、\$ 不算 */
  function mathRanges(text) {
    var m = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, blank)
                .replace(/`[^`\n]+`/g, blank)
                .replace(/\\\$/g, "  ");
    var re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)((?:[^$\n])+?)(?<!\s)\$/g;
    var out = [], r;
    while ((r = re.exec(m))) {
      var disp = r[1] !== undefined || r[2] !== undefined;
      var open = r[1] !== undefined ? 2 : r[4] !== undefined ? 1 : 2;
      out.push({ from: r.index, to: r.index + r[0].length, display: disp,
                 tex: text.slice(r.index + open, r.index + r[0].length - open).trim() });
    }
    return out;
  }
  function blank(s) { return s.replace(/[^\n]/g, " "); }
  function mathAt(pos) {
    var all = mathRanges(bodyText());
    /* 只算真正夹在两个 $ 中间：光标贴在公式后面接着打字时，Ctrl+M 应该是新插一个 */
    for (var i = 0; i < all.length; i++) if (pos > all[i].from && pos < all[i].to) return all[i];
    return null;
  }

  /* 打开公式面板：光标在已有公式里就是改它，选中了文字就拿它当初稿，否则新插一个 */
  function openFx(wantDisplay, anchor, target) {
    if (!ed || !window.FormulaPanel) return;
    if (window.FormulaPanel.isOpen()) { window.FormulaPanel.close(); return; }
    var view = ed.view, st = view.state, sel = st.selection.main;
    var hit = target || (sel.empty ? mathAt(sel.head) : null);
    var from = hit ? hit.from : sel.from, to = hit ? hit.to : sel.to;
    var tex = hit ? hit.tex : st.sliceDoc(sel.from, sel.to).replace(/^\$+|\$+$/g, "");
    var display = hit ? hit.display : !!wantDisplay;
    if (!anchor) {
      var c = view.coordsAtPos(from);
      anchor = c ? { getBoundingClientRect: function () { return { left: c.left, top: c.top, bottom: c.bottom }; } } : $("ed-tools");
    }
    window.FormulaPanel.open({
      anchor: anchor, tex: tex, display: display, editing: !!hit,
      onDone: function (out, disp) { putMath(from, to, out, disp); }
    });
  }

  function putMath(from, to, tex, disp) {
    var view = ed.view, doc = view.state.doc;
    var text;
    if (disp) {
      /* 整段公式要独占几行：前后不是行首/行尾就补换行；断开处留下的行尾空格顺手去掉 */
      while (from > 0 && /[ \t]/.test(doc.sliceString(from - 1, from))) from--;
      while (to < doc.length && /[ \t]/.test(doc.sliceString(to, to + 1))) to++;
      var before = doc.sliceString(Math.max(0, from - 2), from), after = doc.sliceString(to, to + 2);
      var lead = from === 0 || /\n\n$/.test(before) ? "" : /\n$/.test(before) ? "\n" : "\n\n";
      var tail = to === doc.length || /^\n\n/.test(after) ? "" : /^\n/.test(after) ? "\n" : "\n\n";
      text = lead + "$$\n" + tex + "\n$$" + tail;
    } else {
      text = "$" + tex.replace(/\s*\n\s*/g, " ") + "$";
    }
    view.dispatch({ changes: { from: from, to: to, insert: text },
                    selection: { anchor: from + text.length } , scrollIntoView: true });
    view.focus();
    touched();
  }

  /* 预览里点一下公式，就跳回正文里那一处并打开面板改它 */
  function setupFxPreview() {
    preview.addEventListener("click", function (e) {
      var node = e.target.closest(".arithmatex");
      if (!node || !ed) return;
      var nodes = Array.prototype.slice.call(preview.querySelectorAll(".arithmatex"));
      var i = nodes.indexOf(node), all = mathRanges(bodyText());
      if (i < 0 || !all[i]) return;
      ed.view.dispatch({ selection: { anchor: all[i].from }, scrollIntoView: true });
      openFx(all[i].display, node, all[i]);
    });
    preview.title = "";
  }

  /* ------------------------------------------------------------------ 发布 */
  /* 发布结果给的是站内路径；拼成线上地址（本机预览时也指向线上） */
  var home = "";
  function liveUrl(path) {
    var local = location.protocol === "file:" || /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
    return (local && home ? home : location.origin) + path;
  }

  function publish() {
    state.tried = true;
    commitTag();
    var bad = validate();
    if (bad.length) { say(bad.join("；"), "bad"); return; }
    var c = current();
    var isNew = !state.origSlug;
    var moved = state.origSlug && c.slug !== state.origSlug;
    var staged = state.uploads.some(function (u) { return u.path === c.meta.pdf; });
    if (moved) c.oldSlug = state.origSlug;
    say("");
    var lines = ["发布「" + c.meta.title + "」？"];
    if (isNew) lines.push("这是新建。");
    if (moved) lines.push("地址从 /notes/" + state.origSlug + "/ 改成 /notes/" + c.slug + "/，旧链接会失效。");
    if (staged) lines.push("会一起上传 " + c.meta.pdf + "。");
    var imgs = (state.images || []).filter(function (u) { return c.body.indexOf(u.path) >= 0; });
    if (imgs.length) lines.push("会一起上传正文里的 " + imgs.length + " 张图片。");
    if (state.onlineMd) {
      var dc = diffCount(lineDiff(state.onlineMd.split("\n"), serialize(c).split("\n")));
      lines.push("跟线上比 +" + dc.add + " 行、−" + dc.del + " 行。");
    }
    lines.push("会提交并推送到线上。");
    ask(lines.join(""), { ok: "发布", cancel: "先不" }).then(function (y) {
      if (!y) return;
      $("ed-publish").disabled = true;
      setStatus("发布中…");
      api("/api/publish", { method: "POST", body: JSON.stringify(c) }).then(function (r) {
        setStatus("已发布 " + r.sha, "ok");
        state.dirty = false;
        if (r.unchanged) say("内容没变化，没有产生新提交。", "ok");
        else say("已提交 " + r.sha + " 并推送，约 1–2 分钟后线上可见：", "ok", null,
                 { href: liveUrl(r.url), text: r.url });
        var key = state.draftKey || state.origSlug || c.slug;
        api("/api/draft?slug=" + encodeURIComponent(key), { method: "DELETE" }).catch(function () { });
        state.slug = c.slug;
        state.origSlug = c.slug;
        state.draftKey = null;
        state.onlineMd = serialize(c);
        histFor = null;
        lockSlug(true);
        if (pvTab === "diff" || pvTab === "hist") pvMode(pvTab);
        return reloadNotes().then(paintList).then(gitstat).then(pdfInfo);
      }).catch(function (e) {
        setStatus("发布没成功", "bad");
        say((e.step ? "停在「" + e.step + "」：" : "") + e.message, "bad");
      }).then(function () { $("ed-publish").disabled = false; validate(); });
    });
  }

  function takeLists(j) {
    state.notes = j.notes;
    state.drafts = {};
    (j.drafts || []).forEach(function (d) { state.drafts[d.slug] = d.savedAt; });
    state.forms = j.forms || [];
    state.uploads = j.uploads || [];
    state.images = j.images || [];
  }

  function reloadNotes() {
    return api("/api/notes").then(takeLists);
  }

  /* ------------------------------------------------------------------ 解锁 */
  var wantSlug = null;
  function connect(key) {
    state.key = key;
    state.offline = false;
    return api("/api/notes").then(function (j) {
      takeLists(j);
      state.connected = true;
      migrateLocal();
      setStatus("本机服务 · 已连上", "ok");
      $("ed-shell").hidden = false;
      $("ed-lock").hidden = true;
      setLocked(false);
      where();
      paintList();
      gitstat();
      if (MODE !== "note") { var m = MODE; MODE = ""; setMode(m); }
      if (wantSlug) { var s = wantSlug; wantSlug = null; open(s); }
    });
  }

  /* 连接失败分两种：口令错（401）才清掉存着的口令；服务没开就留着口令，
     每 3 秒探一次，开了自动连上 —— 不用再输一遍 */
  function failConnect(e, saved) {
    state.key = null;
    if (e.status === 401) {
      try { localStorage.removeItem(KEYNAME); } catch (_) {}
      showLock(saved ? "存的口令已经不作数了（可能换了配置），重新输一次。" : "口令不对。");
      return;
    }
    showLock("本机服务没开。" + START_HINT + "开了以后这里会自动连上。");
    if (saved) poll(function () { connect(saved).catch(function (e2) { failConnect(e2, saved); }); });
  }

  function showLock(why) {
    state.connected = false;
    $("ed-lock").hidden = false;
    $("ed-shell").hidden = true;
    $("ed-lockmsg").textContent = why || "";
    setStatus("未连接", "bad");
    setLocked(true);
  }

  function askKey(prefill) {
    askText("连接本机服务", "输入 sitekeeper 启动时打印的口令（只存这台电脑）",
            { ok: "连接", password: true, value: prefill || "" }).then(function (r) {
      if (!r.ok) { showLock("没填口令，只能看不能改。"); return; }
      try { localStorage.setItem(KEYNAME, r.value); } catch (e) {}
      connect(r.value).catch(function (e) { failConnect(e, e.status === 401 ? "" : r.value); });
    });
  }

  function unlock() {
    var saved = null;
    try { saved = localStorage.getItem(KEYNAME); } catch (e) {}
    if (saved) connect(saved).catch(function (e) { failConnect(e, saved); });
    else showLock("");
  }

  /* ========================= 作品与日程：另一种表单 ================ */
  var MODE = "note";
  var $all = function (sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); };
  var WFIELDS = ["state", "name", "href", "desc", "stack"];
  var WLIMIT = {state: 12, name: 60, href: 300, desc: 200, stack: 40};
  var WNAME = {state: "状态", name: "名称", href: "链接", desc: "说明", stack: "栈"};
  var DKEY = {work: "lab-ed-work-draft-v1", plan: "lab-ed-plan-draft-v1"};   /* 旧版存在浏览器里的位置，只用来迁移 */
  var START_HINT = /Win/.test(navigator.platform || navigator.userAgent)
    ? "双击 sitekeeper\\start.cmd，" : "在终端里跑 python sitekeeper/keeper.py，";
  var cache = {work: null, plan: null};    /* 线上版本，DOM 里是当前编辑 */
  var secRefs = {};
  var tRowDraft = null, tPlanDraft = null, planTimer = null;
  var TSRE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

  /* 作品和日程的草稿也交给本机服务存（和笔记草稿同一个目录），
     换浏览器、清缓存都不会丢；顶上「草稿 N」也就能一起数到 */
  var formDraft = {work: null, plan: null};
  function saveForm(type, data, quiet) {
    formDraft[type] = data;
    $(type === "work" ? "w-revert" : "p-revert").hidden = false;
    return api("/api/formdraft", { method: "POST", body: JSON.stringify({type: type, data: data}) })
      .then(function () {
        if (state.forms.indexOf(type) < 0) state.forms.push(type);
        state.savedAt = Date.now();
        if (!quiet) sayFor(2500, "草稿已存进本机（仓库外），没有提交。", "ok");
        gitstat();
      })
      .catch(function (e) { if (!quiet || !e.offline) say("草稿没存上：" + e.message, "bad"); });
  }
  function dropForm(type) {
    formDraft[type] = null;
    state.forms = state.forms.filter(function (t) { return t !== type; });
    return api("/api/formdraft?type=" + type, { method: "DELETE" }).catch(function () { })
      .then(gitstat);
  }
  /* 旧版把作品/日程草稿存在 localStorage；连上服务时搬过去一次 */
  function migrateLocal() {
    ["work", "plan"].forEach(function (t) {
      var v = readLocal(DKEY[t]);
      if (!v) return;
      writeLocal(DKEY[t], null);
      if (state.forms.indexOf(t) < 0) saveForm(t, v, true);
    });
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
    document.body.dataset.mode = m;      /* 中栏三块由它互斥，不靠 hidden 单打独斗 */
    var back = document.getElementById("ed-back");
    if (back) {
      back.href = m === "work" ? "/work.html" : m === "plan" ? "/" : "/notes.html";
      back.firstChild.textContent = m === "work" ? "回作品页" : m === "plan" ? "回首页" : "回笔记列表";
    }
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
    if (!formDraft.work && state.forms.indexOf("work") >= 0) {
      return api("/api/formdraft?type=work").then(function (j) { formDraft.work = j.data; loadWork(); },
        function () { state.forms = state.forms.filter(function (t) { return t !== "work"; }); loadWork(); });
    }
    var local = formDraft.work;
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
     ["×", "删掉这一行", function () { removeRow(tr); }]]
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

  /* 删行不弹确认，给 6 秒撤销：插回原来的位置 */
  function removeRow(tr) {
    var parent = tr.parentNode, next = tr.nextSibling;
    var name = tr.querySelector('[data-k="name"]').value.trim() || "这一行";
    parent.removeChild(tr);
    rowTouched();
    sayFor(6000, "删掉了「" + name + "」。", "warn", [["撤销", function () {
      parent.insertBefore(tr, next && next.parentNode === parent ? next : null);
      rowTouched();
    }]]);
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
    if (!state.key) bad = bad.concat("没连上本机服务");
    $("ed-publish").disabled = bad.length > 0;
    $("ed-why-w").textContent = bad.length > 4 ? bad.slice(0, 4).join("；") + "…（共 " + bad.length + " 处）"
                                               : bad.join("；");
    $("ed-why-w").hidden = !bad.length;
    return bad;
  }

  function rowTouched() {
    validateWork();
    clearTimeout(tRowDraft);
    tRowDraft = setTimeout(function () { saveForm("work", collectWork(), true); }, 700);
  }

  /* ------------------------------------------------------------------ 日程 */
  function loadPlan() {
    if (!formDraft.plan && state.forms.indexOf("plan") >= 0) {
      return api("/api/formdraft?type=plan").then(function (j) { formDraft.plan = j.data; loadPlan(); },
        function () { state.forms = state.forms.filter(function (t) { return t !== "plan"; }); loadPlan(); });
    }
    var local = formDraft.plan;
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
    if (!state.key) bad = bad.concat("没连上本机服务");
    $("ed-publish").disabled = bad.length > 0;
    $("ed-why-p").textContent = bad.join("；");
    $("ed-why-p").hidden = !bad.length;
    return bad;
  }

  function planTouched() {
    validatePlan();
    planTick();
    clearTimeout(tPlanDraft);
    tPlanDraft = setTimeout(function () { saveForm("plan", collectPlan(), true); }, 700);
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
          if (r.unchanged) say("内容没变化，没有产生新提交。", "ok");
          else say("已提交 " + r.sha + " 并推送，约 1–2 分钟后线上可见：", "ok", null,
                   { href: liveUrl(r.url), text: r.url });
          cache[type] = data;
          dropForm(type);
          $(type === "work" ? "w-revert" : "p-revert").hidden = true;
          if (type === "work") paintWork(data);
          gitstat();
        })
        .catch(function (e) {
          setStatus("发布没成功", "bad");
          say((e.step ? "停在「" + e.step + "」：" : "") + e.message, "bad");
        })
        .then(function () { $("ed-publish").disabled = false; validate(); });
    });
  }

  /* ------------------------------------------------------------------ 锁 */
  /* 没连上本机服务时整页不许编辑。这挡的是误操作和"以为改成功了"，
     真正的把关在服务那边：没有口令一律 401，路径只认白名单。 */
  function setLocked(on) {
    document.body.classList.toggle("ed-locked", on);
    $all("#ed-shell input,#ed-shell textarea,#ed-shell select,#ed-shell button").forEach(function (el) {
      if (el.id === "btnTheme") return;
      el.disabled = on;
    });
    if (ed) {
      f.body.classList.toggle("ed-off", on);
      var c = f.body.querySelector(".cm-content");
      if (c) c.setAttribute("contenteditable", on ? "false" : "true");
    }
    if (on) state.key = null;
    validate();
  }

  function shortPath(p) {
    var parts = String(p || "").split(/[\\/]+/).filter(Boolean);
    return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : parts.join("/");
  }

  function where() {
    fetch(BASE + "/ping", { cache: "no-store" }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (j) {
      $("ed-where").textContent = j ? "服务在 :" + j.port + " · " + shortPath(j.site) : "";
      if (j && j.home) home = j.home;
    }).catch(function () { $("ed-where").textContent = ""; });
  }

  /* ---------------------------------------------------------------- 分隔条 */
  var RKEY = "lab-ed-split";
  function mid() { return document.querySelector(".ed-mid"); }
  function ratio() {
    var row = document.querySelector(".ed-row").getBoundingClientRect();
    var r = f.body.getBoundingClientRect();
    return row.width ? (r.left - row.left + r.width) / row.width : 0.5;
  }
  function setRatio(r) {
    r = Math.min(0.82, Math.max(0.18, r));
    /* 表头和两栏读同一个比例，宽度才不会各算各的 */
    mid().style.setProperty("--edr", r.toFixed(4));
    try { localStorage.setItem(RKEY, String(r)); } catch (e) {}
  }
  function resetRatio() {
    mid().style.removeProperty("--edr");
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

  /* 窗口窄到放不下两栏时，换成一个切换按钮。它放在右表头而不是工具条里：
     窄屏的预览态会整块隐藏左表头，按钮要是在里面就跟着没了，切不回来 */
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
    document.querySelector(".ed-head .hc-r").appendChild(b);
  }

  /* ---------------------------------------------------------------- PDF */
  /* 上传：文件先进本机服务的上传区（仓库外），字段里填好 /files/xxx.pdf；
     发布这条笔记时服务才把它搬进仓库、和笔记一起提交。
     预览：带着口令向服务要文件，转成 blob 放进 iframe，用浏览器自带的 PDF 阅读器。 */
  var PDF_MAX = 95 * 1024 * 1024, PDF_WARN = 50 * 1024 * 1024;
  var pvTab = "md", pdfUrl = null, pdfShown = "";

  function mb(n) { return n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB"; }

  function suggestName(file) {
    var base = file.name.replace(/\.pdf$/i, "").toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-._]+|[-._]+$/g, "");
    /* 中文文件名转出来只剩零碎字母，不如直接用这条笔记的地址名 */
    if (base.length < 3 || /[^\x00-\x7f]/.test(file.name)) base = f.slug.value.trim() || "file-" + today();
    return base.slice(0, 70) + ".pdf";
  }

  function pickPdf(file) {
    if (!file) return;
    if (!state.key) { say("先连上本机服务再上传。", "bad"); return; }
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { say("只收 PDF 文件。", "bad"); return; }
    if (file.size > PDF_MAX) {
      say(file.name + " 有 " + mb(file.size) + "，超过 GitHub 单文件 100 MB 的上限，先压缩一下。", "bad");
      return;
    }
    askText("上传 PDF", "线上地址会是 /files/<文件名>。只能用小写字母、数字、点、连字符、下划线。" +
            (file.size > PDF_WARN ? "（" + mb(file.size) + "，偏大：GitHub 会警告，访客下载也慢）" : ""),
            { ok: "上传", value: suggestName(file) }).then(function (r) {
      if (!r.ok) return;
      var name = r.value.trim().toLowerCase();
      if (!/\.pdf$/.test(name)) name += ".pdf";
      if (!/^[a-z0-9][a-z0-9._-]{0,78}\.pdf$/.test(name)) {
        say("文件名不合规则：" + name, "bad");
        return;
      }
      send(file, name, false);
    });
  }

  function send(file, name, overwrite) {
    setStatus("上传中… " + mb(file.size));
    fetch(BASE + "/api/upload?name=" + encodeURIComponent(name) + (overwrite ? "&overwrite=1" : ""), {
      method: "POST", headers: { "Content-Type": "application/pdf", "X-Lab-Key": state.key || "" }, body: file
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; });
    }).then(function (x) {
      setStatus("本机服务 · 已连上", "ok");
      if (x.r.status === 409 && x.j.exists) {
        return ask("仓库里已经有 /files/" + name + "（可能别的笔记也在用）。替换成这个新文件？",
                   { ok: "替换", cancel: "换个名字" }).then(function (y) {
          if (y) send(file, name, true); else pickPdf(file);
        });
      }
      if (!x.r.ok) throw new Error(x.j.error || "HTTP " + x.r.status);
      state.uploads = state.uploads.filter(function (u) { return u.path !== x.j.path; })
        .concat([{ path: x.j.path, size: x.j.size }]);
      f.pdf.value = x.j.path;
      pdfShown = "";
      touched();
      pdfInfo();
      gitstat();
      pvMode("pdf");
      say("已上传 " + x.j.path + "（" + mb(x.j.size) + "），发布这条笔记时一起提交。" +
          (x.j.big ? "文件偏大，访客下载会比较慢。" : ""), x.j.big ? "warn" : "ok");
    }).catch(function (e) {
      setStatus("本机服务 · 已连上", "ok");
      say("上传失败：" + (e.message === "Failed to fetch" ? "连不上本机服务" : e.message), "bad");
    });
  }

  function pdfInfo() {
    var box = $("pdf-info"), p = f.pdf.value.trim();
    var tab = document.querySelector('.ed-pvtabs [data-pv="pdf"]');
    if (tab) tab.disabled = !p;
    if (!box) return;
    box.innerHTML = "";
    if (!p) { box.hidden = true; if (pvTab === "pdf") pvMode("md"); return; }
    var up = state.uploads.filter(function (u) { return u.path === p; })[0];
    var txt = /^https?:\/\//.test(p) ? "外链，访客点开会跳过去"
      : up ? mb(up.size) + " · 已上传，发布这条笔记时一起提交"
      : /^\/files\//.test(p) ? "仓库里的文件" : "建议放在 /files/ 下";
    box.appendChild(document.createTextNode(txt + " "));
    var x = document.createElement("button");
    x.type = "button";
    x.className = "mini";
    x.textContent = "移除";
    x.title = "这条笔记不再挂这个 PDF";
    x.onclick = function () {
      if (up) {
        api("/api/upload?path=" + encodeURIComponent(p), { method: "DELETE" }).catch(function () { });
        state.uploads = state.uploads.filter(function (u) { return u !== up; });
        gitstat();
      }
      f.pdf.value = "";
      touched();
      pdfInfo();
    };
    box.appendChild(x);
    box.hidden = false;
  }

  function pvMode(m) {
    var p = f.pdf.value.trim();
    if (m === "pdf" && !p) m = "md";
    pvTab = m;
    document.body.classList.toggle("pv-pdf", m === "pdf");
    document.body.classList.toggle("pv-aux", m === "diff" || m === "hist");
    $all(".ed-pvtabs button").forEach(function (b) { b.classList.toggle("on", b.dataset.pv === m); });
    if (m === "pdf") loadPdf(p);
    if (m === "diff") showChanges();
    if (m === "hist") showHistory();
  }

  function loadPdf(p) {
    var frame = $("ed-pdf-frame"), note = $("ed-pdf-note");
    if (p === pdfShown) return;
    pdfShown = p;
    var show = function (text) { note.textContent = text; note.hidden = !text; frame.hidden = !!text; };
    if (/^https?:\/\//.test(p)) { frame.src = p; show(""); return; }
    show("载入中…");
    fetch(BASE + "/api/file?path=" + encodeURIComponent(p), { headers: { "X-Lab-Key": state.key || "" } })
      .then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || "HTTP " + r.status); });
        return r.blob();
      })
      .then(function (b) {
        if (pdfShown !== p) return;
        if (pdfUrl) URL.revokeObjectURL(pdfUrl);
        pdfUrl = URL.createObjectURL(new Blob([b], { type: "application/pdf" }));
        frame.src = pdfUrl + "#view=FitH";
        show("");
      })
      .catch(function (e) { pdfShown = ""; show("预览不了 " + p + "：" + e.message); });
  }

  function setupPdf() {
    var input = $("pdf-file");
    $("btn-pdf").onclick = function () { input.value = ""; input.click(); };
    input.onchange = function () { pickPdf(input.files[0]); };
    f.pdf.addEventListener("input", function () { pdfShown = ""; pdfInfo(); });
    f.pdf.addEventListener("change", function () { if (pvTab === "pdf") pvMode("pdf"); });
    $all(".ed-pvtabs button").forEach(function (b) {
      b.onclick = function () { pvMode(b.dataset.pv); if (b.dataset.pv === "md") previewNow(); };
    });
    /* 把 PDF 拖到面板任何地方都算上传（只在笔记模式、已连上时） */
    var shell = $("ed-shell"), depth = 0;
    var isFile = function (e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], "Files") >= 0; };
    var isImg = function (e) {
      return [].some.call(e.dataTransfer.items || [], function (it) { return it.kind === "file" && IMGOK.test(it.type); });
    };
    shell.addEventListener("dragenter", function (e) {
      if (!isFile(e) || MODE !== "note") return;
      e.preventDefault();
      depth++;
      mid().setAttribute("data-drop", isImg(e) ? "松手插入图片（落在光标处）" : "松手上传 PDF");
      document.body.classList.add("ed-drop");
    }, true);
    shell.addEventListener("dragover", function (e) { if (isFile(e) && MODE === "note") e.preventDefault(); }, true);
    shell.addEventListener("dragleave", function () {
      if (--depth <= 0) { depth = 0; document.body.classList.remove("ed-drop"); }
    }, true);
    /* 捕获阶段接住：不然 CodeMirror 会把拖进来的文件当文本读进正文 */
    shell.addEventListener("drop", function (e) {
      depth = 0;
      document.body.classList.remove("ed-drop");
      if (!isFile(e) || MODE !== "note") return;
      e.preventDefault();
      e.stopPropagation();
      var files = e.dataTransfer.files;
      if ([].some.call(files, function (x) { return IMGOK.test(x.type); })) {
        var pos = ed && f.body.contains(e.target) ? ed.view.posAtCoords({ x: e.clientX, y: e.clientY }) : null;
        putImages(files, pos);
      } else pickPdf(files[0]);
    }, true);
  }

  /* ================================================================ 自己用的工具 */

  /* ---------------------------------------------------------- 标题 / 大纲 */
  function headings(text) {
    var out = [], fence = null, lines = text.split("\n"), pos = 0;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], fm = /^\s{0,3}(```|~~~)/.exec(ln);
      if (fm) fence = fence === null ? fm[1] : (fence === fm[1] ? null : fence);
      else if (fence === null) {
        var h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(ln);
        if (h) out.push({ level: h[1].length, text: h[2], line: i + 1, pos: pos });
      }
      pos += ln.length + 1;
    }
    return out;
  }

  /* 小浮层：大纲、之后别的列表也用它。点外面或 Esc 关 */
  var pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  function openPop(anchor, build) {
    if (pop) { var same = pop.anchor === anchor; closePop(); if (same) return; }
    pop = document.createElement("div");
    pop.className = "ed-pop";
    pop.anchor = anchor;
    build(pop);
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + "px";
    pop.style.top = Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8) + "px";
  }
  document.addEventListener("mousedown", function (e) {
    if (pop && !pop.contains(e.target) && e.target !== pop.anchor && !(pop.anchor && pop.anchor.contains(e.target))) closePop();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && pop) { closePop(); if (ed) ed.focus(); } });

  function jumpTo(pos) {
    if (!ed) return;
    var view = ed.view;
    view.dispatch({ selection: { anchor: pos }, effects: [] });
    var top = view.lineBlockAt(pos).top;
    view.scrollDOM.scrollTop = Math.max(0, top - 8);
    view.focus();
    syncFrom("ed");
  }

  function openOutline(e) {
    var anchor = (e && e.currentTarget) || $("ed-tools");
    openPop(anchor, function (box) {
      var hs = headings(bodyText());
      var head = document.createElement("div");
      head.className = "ed-pop-h";
      head.textContent = "大纲 · " + hs.length + " 个标题";
      box.appendChild(head);
      if (!hs.length) {
        var p = document.createElement("p");
        p.className = "note";
        p.textContent = "正文里还没有 ## 标题。";
        box.appendChild(p);
        return;
      }
      var min = Math.min.apply(null, hs.map(function (h) { return h.level; }));
      var here = ed ? ed.view.state.selection.main.head : 0, cur = -1;
      hs.forEach(function (h, i) { if (h.pos <= here) cur = i; });
      hs.forEach(function (h, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "ed-pop-i" + (i === cur ? " on" : "");
        b.style.paddingLeft = (8 + (h.level - min) * 14) + "px";
        b.textContent = h.text;
        b.title = "第 " + h.line + " 行";
        b.onclick = function () { closePop(); jumpTo(h.pos); };
        box.appendChild(b);
      });
    });
  }

  /* ---------------------------------------------------------- 滚动同步 */
  /* 以标题为锚点：编辑器里第 k 个标题 ↔ 预览里第 k 个标题，中间按比例插值 */
  var SYNCKEY = "lab-ed-sync";
  var syncOn = (function () { try { return localStorage.getItem(SYNCKEY) !== "0"; } catch (e) { return true; } })();
  var syncLock = { who: "", until: 0 };

  function anchorsY() {
    var view = ed.view, sd = view.scrollDOM;
    var hs = headings(bodyText());
    var ph = preview.querySelectorAll("h1,h2,h3,h4,h5,h6");
    var pr = preview.getBoundingClientRect(), base = preview.scrollTop;
    var pairs = [[0, 0]], n = Math.min(hs.length, ph.length);
    for (var i = 0; i < n; i++) {
      var ey = view.lineBlockAt(hs[i].pos).top;
      var py = ph[i].getBoundingClientRect().top - pr.top + base - 8;
      var last = pairs[pairs.length - 1];
      if (ey > last[0] && py > last[1]) pairs.push([ey, py]);
    }
    var endE = Math.max(sd.scrollHeight - sd.clientHeight, 1), endP = Math.max(preview.scrollHeight - preview.clientHeight, 0);
    var lastP = pairs[pairs.length - 1];
    if (endE > lastP[0]) pairs.push([endE, Math.max(endP, lastP[1])]);
    return pairs;
  }
  function mapY(pairs, y, a, b) {
    for (var i = 0; i < pairs.length - 1; i++) {
      var p = pairs[i], q = pairs[i + 1];
      if (y <= q[a]) {
        var t = q[a] === p[a] ? 0 : (y - p[a]) / (q[a] - p[a]);
        return p[b] + Math.max(0, Math.min(1, t)) * (q[b] - p[b]);
      }
    }
    return pairs[pairs.length - 1][b];
  }
  function syncFrom(who) {
    if (!syncOn || !ed || pvTab !== "md" || MODE !== "note") return;
    if (syncLock.who && syncLock.who !== who && Date.now() < syncLock.until) return;
    var sd = ed.view.scrollDOM, pairs = anchorsY();
    syncLock = { who: who, until: Date.now() + 120 };
    if (who === "ed") preview.scrollTop = mapY(pairs, sd.scrollTop, 0, 1);
    else sd.scrollTop = mapY(pairs, preview.scrollTop, 1, 0);
  }
  function setupSync() {
    if (!ed) return;
    var raf = 0;
    var on = function (who) { return function () {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; syncFrom(who); });
    }; };
    ed.view.scrollDOM.addEventListener("scroll", on("ed"), { passive: true });
    preview.addEventListener("scroll", on("pv"), { passive: true });
  }
  function toggleSync(e) {
    syncOn = !syncOn;
    try { localStorage.setItem(SYNCKEY, syncOn ? "1" : "0"); } catch (_) {}
    paintSyncBtn();
    if (syncOn) syncFrom("ed");
    sayFor(1800, syncOn ? "滚动同步：开" : "滚动同步：关", "ok");
  }
  function paintSyncBtn() {
    var b = document.querySelector('#ed-tools [data-k="sync"]');
    if (b) { b.classList.toggle("on", syncOn); b.title = "预览跟着正文滚动（现在：" + (syncOn ? "开" : "关") + "）"; }
  }

  /* ---------------------------------------------------------- 图片 */
  /* 粘贴、拖进正文、点 ▣ 选文件：先传进本机服务的上传区（仓库外），正文里写 /files/img/xxx；
     发布这条笔记时，服务只把正文里真的引用到的图片搬进仓库。 */
  var IMG_MAX = 10 * 1024 * 1024, imgUrls = {}, imgSeq = 0;
  var IMGOK = /^image\/(png|jpeg|gif|webp|svg\+xml)$/;

  function imgName(file) {
    var ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
    var base = (f.slug.value.trim() || "img").slice(0, 48), d = new Date();
    return base + "-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + "-" + (++imgSeq) + "." + ext;
  }
  function altOf(file) {
    var n = (file.name || "").replace(/\.[a-z0-9]+$/i, "");
    return /^(image|img|screenshot|截图|屏幕截图|粘贴|clipboard)?[\s_-]*\d*$/i.test(n) ? "" : n;
  }

  function putImages(files, pos) {
    files = [].filter.call(files || [], function (x) { return IMGOK.test(x.type); });
    if (!files.length || !ed) return false;
    if (!state.key || state.offline) { say("先连上本机服务，图片才能上传。", "bad"); return true; }
    var view = ed.view;
    if (pos === undefined || pos === null) pos = view.state.selection.main.from;
    files.forEach(function (file) {
      if (file.size > IMG_MAX) { say((file.name || "图片") + " 有 " + mb(file.size) + "，超过 10 MB，先压缩一下。", "bad"); return; }
      var name = imgName(file), token = "![上传中… " + name + "]()";
      var lead = pos > 0 && !/\n$/.test(view.state.sliceDoc(pos - 1, pos)) ? "\n" : "";
      var text = lead + token + "\n";
      view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
      pos += text.length;
      touched();
      fetch(BASE + "/api/image?name=" + encodeURIComponent(name), {
        method: "POST", headers: { "Content-Type": file.type, "X-Lab-Key": state.key || "" }, body: file
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
          return j;
        });
      }).then(function (j) {
        imgUrls[j.path] = URL.createObjectURL(file);
        state.images = (state.images || []).filter(function (u) { return u.path !== j.path; })
          .concat([{ path: j.path, size: j.size }]);
        replaceToken(token, "![" + altOf(file) + "](" + j.path + ")");
        sayFor(2500, "图片已上传（" + mb(j.size) + "），发布这条笔记时一起提交。", "ok");
      }).catch(function (e) {
        replaceToken(token + "\n", "");
        say("图片没传上：" + (e.message === "Failed to fetch" ? "连不上本机服务" : e.message), "bad");
      });
    });
    view.focus();
    return true;
  }
  function replaceToken(token, text) {
    var doc = bodyText(), i = doc.indexOf(token);
    if (i < 0) return;
    ed.view.dispatch({ changes: { from: i, to: i + token.length, insert: text } });
    touched();
  }

  /* 预览里还没进仓库的图片：带口令向服务要，转成 blob 显示 */
  function fixPreviewImages() {
    $all("img", preview).forEach(function (img) {
      var src = img.getAttribute("src") || "";
      if (!/^\/files\/img\//.test(src)) return;
      if (imgUrls[src]) { img.src = imgUrls[src]; return; }
      var staged = (state.images || []).some(function (u) { return u.path === src; });
      if (!staged) return;
      fetch(BASE + "/api/file?path=" + encodeURIComponent(src), { headers: { "X-Lab-Key": state.key || "" } })
        .then(function (r) { return r.ok ? r.blob() : null; })
        .then(function (b) { if (b) { imgUrls[src] = URL.createObjectURL(b); img.src = imgUrls[src]; } })
        .catch(function () { });
    });
  }

  function setupImages() {
    var input = $("img-file");
    input.onchange = function () { putImages(input.files); input.value = ""; };
    f.body.addEventListener("paste", function (e) {
      var files = e.clipboardData && e.clipboardData.files;
      if (files && files.length && [].some.call(files, function (x) { return IMGOK.test(x.type); })) {
        e.preventDefault();
        e.stopPropagation();
        putImages(files);
      }
    }, true);
  }

  /* ---------------------------------------------------------- 逐行对比 */
  function lineDiff(a, b) {
    var pre = 0, suf = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    var A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf), ops = [], i, j;
    for (i = 0; i < pre; i++) ops.push([" ", a[i]]);
    if (A.length * B.length > 4e6) {            /* 太长就不细算了：整段删、整段加 */
      A.forEach(function (s) { ops.push(["-", s]); });
      B.forEach(function (s) { ops.push(["+", s]); });
    } else {
      var n = A.length, m = B.length, L = [];
      for (i = 0; i <= n; i++) L.push(new Uint32Array(m + 1));
      for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--)
        L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      i = 0; j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && A[i] === B[j]) { ops.push([" ", A[i]]); i++; j++; }
        else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { ops.push(["+", B[j]]); j++; }
        else { ops.push(["-", A[i]]); i++; }
      }
    }
    for (i = a.length - suf; i < a.length; i++) ops.push([" ", a[i]]);
    return ops;
  }
  function diffCount(ops) {
    var add = 0, del = 0;
    ops.forEach(function (o) { if (o[0] === "+") add++; else if (o[0] === "-") del++; });
    return { add: add, del: del };
  }
  /* 只画改动和前后两行，其余折成一行「… 省略 N 行」 */
  function paintDiff(box, ops) {
    var keep = ops.map(function () { return false; }), CTX = 2;
    ops.forEach(function (o, k) {
      if (o[0] !== " ") for (var d = -CTX; d <= CTX; d++) if (ops[k + d]) keep[k + d] = true;
    });
    var pre = document.createElement("div");
    pre.className = "ed-diff";
    var oldNo = 0, newNo = 0, skip = 0;
    var flush = function () {
      if (!skip) return;
      var s = document.createElement("div");
      s.className = "dl skip";
      s.textContent = "… 没变的 " + skip + " 行";
      pre.appendChild(s);
      skip = 0;
    };
    ops.forEach(function (o, k) {
      if (o[0] !== "+") oldNo++;
      if (o[0] !== "-") newNo++;
      if (!keep[k]) { skip++; return; }
      flush();
      var row = document.createElement("div");
      row.className = "dl" + (o[0] === "+" ? " add" : o[0] === "-" ? " del" : "");
      var no = document.createElement("span");
      no.className = "no";
      no.textContent = o[0] === "-" ? oldNo : newNo;
      var tx = document.createElement("span");
      tx.className = "tx";
      tx.textContent = (o[0] === " " ? "  " : o[0] + " ") + o[1];
      row.appendChild(no);
      row.appendChild(tx);
      if (o[0] !== "-") {
        var line = newNo;
        row.title = "点一下跳到正文第 " + line + " 行";
        row.onclick = function () { jumpLine(line); };
      }
      pre.appendChild(row);
    });
    flush();
    box.appendChild(pre);
  }
  /* 对比里的行号含 front matter；正文从 --- 之后开始 */
  function jumpLine(n) {
    if (!ed) return;
    var head = serialize(current()).split("\n").length - bodyText().trim().split("\n").length - 1;
    var ln = Math.max(1, Math.min(ed.view.state.doc.lines, n - head));
    jumpTo(ed.view.state.doc.line(ln).from);
  }

  /* 线上版本按同一套格式重新拼一遍再比，避免只因 front matter 写法不同就满屏红绿 */
  function norm(md) {
    var p = parseMd(md);
    return serialize({ meta: p.meta, body: p.body });
  }

  function auxBox(title) {
    var box = $("ed-aux");
    box.innerHTML = "";
    if (title) {
      var h = document.createElement("div");
      h.className = "ed-aux-h";
      h.textContent = title;
      box.appendChild(h);
    }
    return box;
  }
  function auxNote(box, text) {
    var p = document.createElement("p");
    p.className = "note";
    p.textContent = text;
    box.appendChild(p);
  }

  function showChanges() {
    if (pvTab !== "diff") return;
    if (!state.onlineMd) {
      auxNote(auxBox("改动"), "这条还没发布过，整篇都是新的。");
      return;
    }
    var ops = lineDiff(state.onlineMd.split("\n"), serialize(current()).split("\n"));
    var c = diffCount(ops);
    var box = auxBox(c.add || c.del ? "跟线上比：+" + c.add + " 行，−" + c.del + " 行" : "跟线上一模一样");
    if (c.add || c.del) {
      paintDiff(box, ops);
      var b = document.createElement("button");
      b.type = "button";
      b.className = "mini";
      b.textContent = "全部撤回到线上版本";
      b.onclick = function () {
        ask("把这条笔记（字段和正文）恢复成线上的样子？这次没发布的改动都会丢掉。", { ok: "撤回", cancel: "不了" })
          .then(function (y) {
            if (!y) return;
            var p = parseMd(state.onlineMd);
            fill(p.meta, p.body);
            lockSlug(true);
            touched();
            showChanges();
          });
      };
      box.appendChild(b);
    } else auxNote(box, "这次还没改什么。");
  }

  var histFor = null, histRows = [];
  function showHistory(force) {
    if (pvTab !== "hist") return;
    var slug = state.origSlug;
    if (!slug) { auxNote(auxBox("历史"), "这条还没发布过，没有历史版本。"); return; }
    if (histFor === slug && !force) return paintHistory();
    auxNote(auxBox("历史"), "读取中…");
    api("/api/history?slug=" + encodeURIComponent(slug)).then(function (j) {
      histFor = slug;
      histRows = j.versions || [];
      paintHistory();
    }).catch(function (e) { auxNote(auxBox("历史"), "读不到历史：" + e.message); });
  }
  function when(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + hhmm(d);
  }
  function paintHistory(sel) {
    var box = auxBox("历史 · " + histRows.length + " 个版本（新到旧）");
    if (!histRows.length) { auxNote(box, "git 里还没有这条笔记的提交。"); return; }
    var ul = document.createElement("div");
    ul.className = "ed-hist";
    histRows.forEach(function (v, k) {
      var row = document.createElement("div");
      row.className = "hv" + (sel === v.sha ? " on" : "");
      var t = document.createElement("span");
      t.className = "t";
      t.textContent = when(v.time) + (k === 0 ? " · 线上" : "");
      var m = document.createElement("span");
      m.className = "m";
      m.textContent = v.msg + " · " + v.sha.slice(0, 7);
      var acts = document.createElement("span");
      acts.className = "acts";
      var cmp = document.createElement("button");
      cmp.type = "button";
      cmp.className = "mini";
      cmp.textContent = "对比";
      cmp.title = "那个版本 → 现在编辑器里的";
      cmp.onclick = function () { compareWith(v); };
      var use = document.createElement("button");
      use.type = "button";
      use.className = "mini";
      use.textContent = "取回";
      use.title = "把那个版本放进编辑器（不会自动发布）";
      use.onclick = function () { restoreVersion(v); };
      acts.appendChild(cmp);
      acts.appendChild(use);
      row.appendChild(t);
      row.appendChild(acts);
      row.appendChild(m);
      ul.appendChild(row);
    });
    box.appendChild(ul);
    return box;
  }
  function versionMd(v) {
    if (v.md) return Promise.resolve(v.md);
    return api("/api/history?slug=" + encodeURIComponent(state.origSlug) + "&sha=" + v.sha)
      .then(function (j) { v.md = j.md; return j.md; });
  }
  function compareWith(v) {
    versionMd(v).then(function (md) {
      if (pvTab !== "hist") return;
      var box = paintHistory(v.sha);
      var ops = lineDiff(norm(md).split("\n"), serialize(current()).split("\n"));
      var c = diffCount(ops);
      var h = document.createElement("div");
      h.className = "ed-aux-h";
      h.textContent = when(v.time) + " 那版 → 现在：+" + c.add + " 行，−" + c.del + " 行";
      box.appendChild(h);
      if (c.add || c.del) paintDiff(box, ops); else auxNote(box, "跟现在一模一样。");
    }).catch(function (e) { say("读不到那个版本：" + e.message, "bad"); });
  }
  function restoreVersion(v) {
    ask("把 " + when(v.time) + " 的版本放进编辑器？现在编辑器里的内容会被替换（可以 Ctrl+Z 撤回正文），要发布才会上线。",
        { ok: "取回", cancel: "不了" }).then(function (y) {
      if (!y) return;
      return versionMd(v).then(function (md) {
        var p = parseMd(md);
        p.meta.slug = f.slug.value.trim();           /* 地址名保持现在的，取回不等于改地址 */
        if (!p.meta.pdf) p.meta.pdf = "";
        fill(p.meta, p.body);
        touched();
        say("已取回 " + when(v.time) + " 的版本，检查一下再发布。", "warn");
        pvMode("diff");
      });
    }).catch(function (e) { say("取回失败：" + e.message, "bad"); });
  }

  /* ---------------------------------------------------------- 笔记搜索 */
  var noteQ = "";
  function noteMatch(n) {
    if (!noteQ) return true;
    var hay = [n.title, n.slug, n.sub, (n.tags || []).join(" "), n.cat, CATS[n.cat] || "", n.date]
      .join(" ").toLowerCase();
    return noteQ.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
  }
  function setupSearch() {
    var q = $("ed-q");
    q.addEventListener("input", function () { noteQ = q.value.trim().toLowerCase(); paintList(); });
    q.addEventListener("keydown", function (e) {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        var first = sortedNotes().filter(noteMatch)[0];
        if (first) open(first.slug);
      } else if (e.key === "Escape") {
        q.value = ""; noteQ = ""; paintList(); q.blur();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || MODE !== "note") return;
      var t = e.target;
      if (t && (t.closest && t.closest(".cm-editor") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      q.focus();
      q.select();
    });
  }

  /* ---------------------------------------------------------- 专注模式 */
  function toggleFocus() {
    var on = document.body.classList.toggle("ed-focus");
    $("btnFocus").textContent = on ? "退出专注" : "专注";
    if (ed) ed.focus();
  }

  /* ---------------------------------------------------------------- 状态行 */
  function stat(c) {
    if (!ed) return;
    c = c || ed.cursor();
    var v = bodyText();
    var lines = v.split("\n").length;
    var blocks = (v.match(/^\s{0,3}(#{2,3}\s|>\s|-{3,}\s|\|)/gm) || []).length;
    var math = (v.match(/\$\$/g) || []).length >> 1;
    var saved = state.dirty ? " · 未存" : state.savedAt ? " · 草稿已存 " + hhmm(new Date(state.savedAt)) : "";
    var inFx = c.pos !== undefined && mathAt(c.pos) ? " · 光标在公式里，Ctrl+M 改它" : "";
    var r = ed.view.state.selection.main;
    var picked = r.empty ? "" : " · 选中 " + (r.to - r.from) + " 字符";
    var hs = headings(v), here = r.head, sec = "";
    hs.forEach(function (h) { if (h.pos <= here) sec = h.text; });
    $("ed-stat").textContent = "第 " + c.line + " 行 第 " + c.col + " 列" + picked + " · " + v.length +
      " 字符 · " + lines + " 行 · 整段公式 " + math + " 处" + (sec ? " · 在「" + sec + "」" : "") + saved + inFx;
  }

  /* ------------------------------------------------------------------ 装配 */
  function boot() {
    $("ed-cats").querySelectorAll(".chip").forEach(function (b) {
      b.onclick = function () { setCat(b.dataset.cat); touched(); };
    });
    $all("#ed-modes .chip").forEach(function (b) {
      b.onclick = function () { setMode(b.dataset.mode); };
    });
    $("ed-sort").onclick = function () {
      state.sort = state.sort === "stub" ? "date" : "stub";
      try { localStorage.setItem(SORTKEY, state.sort); } catch (e) {}
      paintList();
    };
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
      dropForm("work");
      $("w-revert").hidden = true;
      if (cache.work) paintWork(cache.work);
      say("回到线上版本了。", "ok");
    };
    $("p-revert").onclick = function () {
      dropForm("plan");
      $("p-revert").hidden = true;
      if (cache.plan) fillPlan(cache.plan);
      say("回到线上版本了。", "ok");
    };
    paintTools();
    setupFxPreview();
    paintTags();
    setupSplit();
    setupPvToggle();

    ["title", "date", "sub", "slug", "pdf"].forEach(function (k) {
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
    var tagIn = $("tag-input");
    tagIn.addEventListener("keydown", function (e) {
      if (e.isComposing) return;                 /* 中文输入法选词时的回车不算 */
      if (e.key === "Enter" || e.key === "," || e.key === "，" || (e.key === "Tab" && tagIn.value.trim())) {
        e.preventDefault();
        commitTag();
      } else if (e.key === "Backspace" && !tagIn.value && tags.length) {
        tags.pop();
        paintTags();
        touched();
      }
    });
    tagIn.addEventListener("input", function () { if (/[,，、]/.test(tagIn.value)) commitTag(); });
    tagIn.addEventListener("blur", commitTag);
    $("ed-tags").addEventListener("click", function (e) { if (e.target === this) tagIn.focus(); });

    /* 摘要是列表页的一行：回车不换行，粘进来的换行也压成空格 */
    f.sub.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) e.preventDefault(); });
    f.sub.addEventListener("input", function () {
      if (/[\r\n]/.test(f.sub.value)) {
        var p = f.sub.selectionStart;
        f.sub.value = f.sub.value.replace(/\s*[\r\n]+\s*/g, " ");
        f.sub.selectionStart = f.sub.selectionEnd = Math.min(p, f.sub.value.length);
      }
    });

    /* 字段失焦后才报那一项的错 */
    ["title", "date", "sub", "slug"].forEach(function (k) {
      f[k].addEventListener("blur", function () {
        if (f[k].value.trim() || state.shown[k]) { state.shown[k] = true; validate(); }
      });
    });

    $("btn-slug").onclick = function () {
      if (f.slug.readOnly) {
        ask("改地址名以后，旧链接 /notes/" + state.origSlug + "/ 会失效（发布时才生效）。", { ok: "要改", cancel: "算了" })
          .then(function (y) { if (y) { lockSlug(false); f.slug.focus(); f.slug.select(); } });
      } else {
        f.slug.value = state.origSlug;
        lockSlug(true);
        touched();
      }
    };

    $("ed-new").onclick = function () {
      leave().then(function (go) {
        if (!go) return;
        fresh();
        state.dirty = false;
        say("");
        validate();
        paintList();
        stat();
        f.title.focus();
      });
    };
    setupPdf();
    setupImages();
    setupSearch();
    /* 正文里的 Ctrl+B / I / K：加粗、斜体、链接。捕获阶段抢在 CodeMirror 自带的 Ctrl+I（选父节点）前面 */
    f.body.addEventListener("keydown", function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || !ed) return;
      var k = e.key.toLowerCase();
      var run = k === "b" ? function () { wrap("**", "**", "粗体"); }
              : k === "i" ? function () { wrap("_", "_", "斜体"); }
              : k === "k" ? function () { wrap("[", "](https://)", "文字"); } : null;
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    }, true);
    setupSync();
    paintSyncBtn();
    $("btnFocus").onclick = toggleFocus;
    $("ed-draft").onclick = function () { saveDraft(false); };
    $("ed-disconnect").onclick = function () {
      ask("断开本机服务？没发布的草稿仍留在这台电脑上。", { ok: "断开", cancel: "留着" }).then(function (y) {
        if (!y) return;
        try { localStorage.removeItem(KEYNAME); } catch (e) {}
        showLock("已断开。要再改内容得重新输口令。");
      });
    };
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
        if (MODE === "work") saveForm("work", collectWork(), false);
        else if (MODE === "plan") saveForm("plan", collectPlan(), false);
        else saveDraft(false);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "m" && MODE === "note" && ed) {
        e.preventDefault();
        openFx(e.shiftKey);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "." && MODE === "note") {
        e.preventDefault();
        toggleFocus();
        return;
      }
      if (window.FormulaPanel && window.FormulaPanel.isOpen()) return;   /* 面板里的 Ctrl+Enter 归面板 */
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("ed-publish").disabled) {
        e.preventDefault();
        $("ed-publish").click();
      }
    });
    /* 关页面时先试着把草稿存掉；存不掉（没地址名、服务断了）才让浏览器拦一下 */
    window.addEventListener("beforeunload", function (e) {
      if (!state.dirty) return;
      if (state.key && !state.offline && draftKeyNow(current())) {
        saveDraft(true);
        return;
      }
      e.preventDefault();
      e.returnValue = "";
    });

    fresh();
    document.body.dataset.mode = MODE;
    setLocked(true);                 /* 先当没连上，连成了再放开 */
    where();
    validate();
    unlock();

    try { wantSlug = new URLSearchParams(location.search).get("slug"); } catch (e) {}
    if (wantSlug && state.key && state.notes.length) { var s = wantSlug; wantSlug = null; open(s); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
