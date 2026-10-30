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
      body: f.body.value
    };
  }

  function fill(meta, body) {
    f.title.value = meta.title || "";
    f.date.value = meta.date || "";
    f.sub.value = meta.sub || "";
    f.slug.value = meta.slug || "";
    f.body.value = body || "";
    setCat(meta.cat || "math");
    setTags(meta.tags || []);
  }

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
    api("/api/render", { method: "POST", body: JSON.stringify({ body: f.body.value }) })
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
    if (!state.key || !SLUGRE.test(c.slug)) return Promise.resolve();
    var md = serialize(c);
    return api("/api/draft", { method: "POST", body: JSON.stringify({ slug: c.slug, md: md }) })
      .then(function () {
        state.drafts[c.slug] = Date.now();
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
    var el = f.body, s = el.selectionStart, e = el.selectionEnd;
    var sel = el.value.slice(s, e) || placeholder || "";
    el.value = el.value.slice(0, s) + before + sel + after + el.value.slice(e);
    el.focus();
    el.selectionStart = s + before.length;
    el.selectionEnd = s + before.length + sel.length;
    touched();
  }

  var TOOLS = [
    { k: "B", t: "加粗", run: function () { wrap("**", "**", "粗体"); } },
    { k: "I", t: "斜体", run: function () { wrap("_", "_", "斜体"); } },
    { k: "Tt", t: "行内代码", run: function () { wrap("`", "`", "code"); } },
    { k: "▤", t: "代码块", run: function () { wrap("\n```cpp\n", "\n```\n", "// code\n"); } },
    { k: "∑", t: "行内公式", run: function () { wrap("$", "$", "A v = \\lambda v"); } },
    { k: "≡", t: "整段公式", run: function () { wrap("\n$$\n", "\n$$\n", "Q^{T}AQ = \\Lambda"); } },
    { k: "↗", t: "链接", run: function () { wrap("[", "](https://)", "文字"); } },
    { k: "❞", t: "引用", run: function () { wrap("\n> ", "", "引文"); } },
    { k: "•", t: "列表", run: function () { wrap("\n- ", "", "一项"); } },
    { k: "▦", t: "表格骨架", run: function () {
        wrap("\n|  |  |  |\n|---|---|---|\n|  |  |  |\n", "", "");
      } },
    { k: "▣", t: "图片路径", run: function () { wrap("![", "](/assets/)", "说明"); } }
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

  /* ------------------------------------------------------------------ 装配 */
  function boot() {
    var d = new Date();
    $("ed-cats").querySelectorAll(".chip").forEach(function (b) {
      b.onclick = function () { setCat(b.dataset.cat); touched(); };
    });
    paintTools();
    paintTags();

    ["title", "date", "sub", "slug"].forEach(function (k) {
      f[k].addEventListener("input", touched);
    });
    f.date.addEventListener("change", touched);
    f.body.addEventListener("input", touched);
    f.body.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault();
        var s = this.selectionStart;
        this.value = this.value.slice(0, s) + "  " + this.value.slice(this.selectionEnd);
        this.selectionStart = this.selectionEnd = s + 2;
        touched();
      }
    });
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
    $("ed-publish").onclick = publish;
    $("ed-retry").onclick = function () {
      var saved = null;
      try { saved = localStorage.getItem(KEYNAME); } catch (e) {}
      askKey(saved || "");
    };
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveDraft(false); }
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
