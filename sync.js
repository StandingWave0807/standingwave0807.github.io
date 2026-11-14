/* 预算 / 日程的跨设备同步：电脑和手机都把数据加密后存到仓库的 sync/*.dat，经 GitHub API 读写。
   · 加密：口令 → PBKDF2-SHA256（60 万轮）→ AES-256-GCM，和 vault.html 同一套参数。
     仓库是公开的，别人能下载 .dat，但没有口令解不开。
   · 口令不落盘。派生出的密钥是「不可导出」的 CryptoKey，存在本机 IndexedDB 里，
     所以每台设备只要解锁一次；「忘掉这台设备」会把它和令牌一起删掉。
   · 合并：每台设备记住上次同步完的那一版（base），按 id 做三方合并：
     只有一边改了就用改的那边，两边改了同一条就以本机为准，删除也能同步过去。
   · 电脑上本机服务那份 json 仍是主存储，这里只是在它之外再同步一份到远端。

   页面这样接：
     LabSync.attach("budget", { get: () => S.data, set: d => { S.data = d; 存盘并重画 } });
     改完存好以后 LabSync.kick("budget")。 */
(function () {
  'use strict';

  var FORMAT = "standingwave-sync-v1";
  var ITER = 600000;
  var DEF = { owner: "StandingWave0807", repo: "standingwave0807.github.io", branch: "main" };
  var DB = "labsync", ST = "kv";
  var enc = new TextEncoder(), dec = new TextDecoder();

  /* ------------------------------------------------------------ 小工具 */
  function b64(buf) {
    var s = "", a = new Uint8Array(buf), CH = 0x8000;
    for (var i = 0; i < a.length; i += CH) s += String.fromCharCode.apply(null, a.subarray(i, i + CH));
    return btoa(s);
  }
  function unb64(str) {
    var s = atob(String(str).replace(/\s+/g, "")), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function stable(x) {
    if (Array.isArray(x)) return "[" + x.map(stable).join(",") + "]";
    if (x && typeof x === "object") {
      return "{" + Object.keys(x).filter(function (k) { return x[k] !== undefined; }).sort()
        .map(function (k) { return JSON.stringify(k) + ":" + stable(x[k]); }).join(",") + "}";
    }
    return JSON.stringify(x === undefined ? null : x);
  }
  function eq(a, b) {
    if (a === b) return true;
    if (a === undefined || b === undefined) return false;
    return stable(a) === stable(b);
  }
  function isObj(x) { return x && typeof x === "object" && !Array.isArray(x); }
  function keyed(a) { return Array.isArray(a) && a.length > 0 && a.every(function (x) { return isObj(x) && typeof x.id === "string"; }); }
  function prim(a) { return Array.isArray(a) && a.every(function (x) { return x === null || typeof x !== "object"; }); }

  /* ------------------------------------------------------------ 三方合并
     merge3(base, mine, theirs)：mine 是本机，冲突时以 mine 为准。base 可以是 undefined（第一次同步）。 */
  function merge3(b, l, r) {
    if (eq(l, r)) return clone(l);
    if (b !== undefined && eq(l, b)) return clone(r);
    if (b !== undefined && eq(r, b)) return clone(l);
    if (isObj(l) && isObj(r)) {
      var bo = isObj(b) ? b : {}, out = {}, seen = {};
      Object.keys(l).concat(Object.keys(r)).forEach(function (k) {
        if (seen[k]) return;
        seen[k] = 1;
        var v = merge3(b === undefined ? undefined : bo[k], l[k], r[k]);
        if (v !== undefined) out[k] = v;
      });
      return out;
    }
    if (Array.isArray(l) && Array.isArray(r) && (keyed(l) || keyed(r)) &&
        (l.length === 0 || keyed(l)) && (r.length === 0 || keyed(r))) {
      return mergeKeyed(b === undefined ? undefined : (Array.isArray(b) ? b : []), l, r);
    }
    if (prim(l) && prim(r) && (b === undefined || prim(b))) return mergeSet(b, l, r);
    if (l === undefined) {
      /* 本机删了：远端没动过就删，远端改过就留远端那份 */
      return b !== undefined && eq(r, b) ? undefined : clone(r);
    }
    if (r === undefined) return b !== undefined && eq(l, b) ? undefined : clone(l);
    return clone(l);
  }
  function mergeKeyed(b, l, r) {
    var bm = {}, lm = {}, rm = {}, order = [], out = [];
    (b || []).forEach(function (x) { if (isObj(x)) bm[x.id] = x; });
    l.forEach(function (x) { lm[x.id] = x; order.push(x.id); });
    r.forEach(function (x) { rm[x.id] = x; if (!(x.id in lm)) order.push(x.id); });
    order.forEach(function (id) {
      var bx = b === undefined ? undefined : bm[id], lx = lm[id], rx = rm[id], v;
      if (lx && rx) v = merge3(bx, lx, rx);
      else if (lx) v = (bx && eq(lx, bx)) ? undefined : clone(lx);      /* 远端删了，本机没改过 → 删 */
      else v = (bx && eq(rx, bx)) ? undefined : clone(rx);              /* 本机删了，远端没改过 → 删 */
      if (v !== undefined) out.push(v);
    });
    return out;
  }
  function mergeSet(b, l, r) {
    var bs = {}, ls = {}, rs = {}, out = [];
    (b || []).forEach(function (x) { bs[JSON.stringify(x)] = 1; });
    l.forEach(function (x) { ls[JSON.stringify(x)] = 1; });
    r.forEach(function (x) { rs[JSON.stringify(x)] = 1; });
    l.concat(r).forEach(function (x) {
      var k = JSON.stringify(x);
      if (out.some(function (y) { return JSON.stringify(y) === k; })) return;
      var inB = !!bs[k] && b !== undefined, inL = !!ls[k], inR = !!rs[k];
      if ((inL && inR) || (inL && !inB) || (inR && !inB)) out.push(x);
    });
    return out;
  }

  /* ------------------------------------------------------------ IndexedDB */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (ok, no) {
      if (!window.indexedDB) return no(new Error("这个浏览器没有 IndexedDB"));
      var q = indexedDB.open(DB, 1);
      q.onupgradeneeded = function () { q.result.createObjectStore(ST); };
      q.onsuccess = function () { ok(q.result); };
      q.onerror = function () { no(q.error); };
    });
    return dbp;
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, no) {
        var t = d.transaction(ST, mode), s = t.objectStore(ST), r = fn(s);
        t.oncomplete = function () { ok(r && "result" in r ? r.result : undefined); };
        t.onerror = function () { no(t.error); };
        t.onabort = function () { no(t.error || new Error("IndexedDB 中止")); };
      });
    });
  }
  function kget(k) { return idb("readonly", function (s) { return s.get(k); }); }
  function kset(k, v) { return idb("readwrite", function (s) { s.put(v, k); }); }
  function kdel(k) { return idb("readwrite", function (s) { s.delete(k); }); }
  function kclear() { return idb("readwrite", function (s) { s.clear(); }); }

  /* ------------------------------------------------------------ 加解密 */
  function derive(pass, salt, iter) {
    return crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: iter, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
  }
  function pipe(bytes, stream) {
    var s = new Blob([bytes]).stream().pipeThrough(stream);
    return new Response(s).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  var CAN_ZIP = typeof CompressionStream === "function" && typeof DecompressionStream === "function";
  function seal(key, salt, obj, extra) {
    var raw = enc.encode(JSON.stringify(obj));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return (CAN_ZIP ? pipe(raw, new CompressionStream("gzip")) : Promise.resolve(raw)).then(function (body) {
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, body);
    }).then(function (ct) {
      var o = { format: FORMAT, kdf: "PBKDF2-SHA256", cipher: "AES-256-GCM", iterations: ITER,
                salt: b64(salt), iv: b64(iv), zip: CAN_ZIP ? "gzip" : "", ciphertext: b64(ct),
                updated: new Date().toISOString() };
      if (extra) for (var k in extra) o[k] = extra[k];
      return o;
    });
  }
  function open(key, env) {
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, key, unb64(env.ciphertext)).then(function (buf) {
      var u = new Uint8Array(buf);
      if (env.zip === "gzip") {
        if (!CAN_ZIP) throw new Error("这个浏览器解不了压缩，升级一下系统");
        return pipe(u, new DecompressionStream("gzip"));
      }
      return u;
    }).then(function (u) { return JSON.parse(dec.decode(u)); });
  }

  /* ------------------------------------------------------------ GitHub */
  function gh(cfg, path, opt) {
    opt = opt || {};
    var url = "https://api.github.com/repos/" + encodeURIComponent(cfg.owner) + "/" + encodeURIComponent(cfg.repo) + path;
    var h = { "Accept": opt.accept || "application/vnd.github+json", "Authorization": "Bearer " + cfg.token,
              "X-GitHub-Api-Version": "2022-11-28" };
    if (opt.body) h["Content-Type"] = "application/json";
    return fetch(url, { method: opt.method || "GET", headers: h, body: opt.body, cache: "no-store" }).catch(function () {
      var e = new Error("连不上 GitHub（没网，或者被墙了）");
      e.status = 0;
      throw e;
    }).then(function (r) {
      if (opt.raw && r.ok) return r.text();
      return r.text().then(function (t) {
        var j = {};
        try { j = t ? JSON.parse(t) : {}; } catch (_) {}
        if (!r.ok) {
          var e = new Error(ghWhy(r.status, j));
          e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }
  function ghWhy(s, j) {
    if (s === 401) return "令牌无效或已过期";
    if (s === 403) return /rate limit/i.test(j.message || "") ? "GitHub 限流了，过几分钟再试" : "令牌没有写这个仓库的权限";
    if (s === 404) return "找不到仓库或文件（检查仓库名，或令牌没勾这个仓库）";
    if (s === 409 || s === 422) return "远端刚被改过";
    return "GitHub 返回 " + s + (j.message ? "：" + j.message : "");
  }
  function filePath(name) { return "/contents/sync/" + name + ".dat"; }
  function pull(cfg, name) {
    return gh(cfg, filePath(name) + "?ref=" + encodeURIComponent(cfg.branch)).then(function (j) {
      if (j.content && j.encoding === "base64") return { sha: j.sha, text: dec.decode(unb64(j.content)) };
      return gh(cfg, filePath(name) + "?ref=" + encodeURIComponent(cfg.branch),
                { accept: "application/vnd.github.raw", raw: true }).then(function (t) { return { sha: j.sha, text: t }; });
    }).catch(function (e) {
      if (e.status === 404) return null;
      throw e;
    });
  }
  function push(cfg, name, text, sha, device) {
    var body = { message: "sync(" + name + "): " + (device || "device"), content: b64(enc.encode(text)), branch: cfg.branch };
    if (sha) body.sha = sha;
    return gh(cfg, filePath(name), { method: "PUT", body: JSON.stringify(body) }).then(function (j) { return j.content.sha; });
  }
  function checkRepo(cfg) {
    return gh(cfg, "").then(function (j) {
      if (j.permissions && !j.permissions.push) {
        var e = new Error("令牌只有读权限，要给 Contents 勾上 Read and write");
        e.status = 403;
        throw e;
      }
      return j;
    });
  }

  /* ------------------------------------------------------------ 设备状态 */
  var S = { cfg: null, key: null, salt: null, dkey: null, ready: false, loaded: null,
            stores: {}, listeners: [], memOnly: false };

  function deviceName() {
    var u = navigator.userAgent;
    if (/iPhone/.test(u)) return "iPhone";
    if (/iPad/.test(u)) return "iPad";
    if (/Android/.test(u)) return "Android";
    if (/Mac/.test(u)) return "Mac";
    if (/Win/.test(u)) return "Windows";
    return "browser";
  }
  /* 本机静态加密用的随机密钥：只用来加密 IndexedDB 里存的 base / 离线副本，不出这台设备 */
  function deviceKey() {
    if (S.dkey) return Promise.resolve(S.dkey);
    return kget("dkey").then(function (k) {
      if (k) return (S.dkey = k);
      return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]).then(function (k2) {
        S.dkey = k2;
        return kset("dkey", k2).then(function () { return k2; });
      });
    });
  }
  function putLocal(slot, obj) {
    return deviceKey().then(function (k) {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, k, enc.encode(JSON.stringify(obj))).then(function (ct) {
        return kset(slot, { iv: iv, ct: new Uint8Array(ct) });
      });
    });
  }
  function getLocal(slot) {
    return kget(slot).then(function (v) {
      if (!v) return undefined;
      return deviceKey().then(function (k) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: v.iv }, k, v.ct);
      }).then(function (b) { return JSON.parse(dec.decode(b)); }).catch(function () { return undefined; });
    });
  }

  function load() {
    if (S.loaded) return S.loaded;
    S.loaded = Promise.all([kget("cfg"), kget("key"), kget("salt")]).then(function (a) {
      S.cfg = a[0] || null;
      S.key = a[1] || null;
      S.salt = a[2] ? new Uint8Array(a[2]) : null;
      S.ready = !!(S.cfg && S.cfg.token && S.key && S.salt);
      emitAll();
      return S.ready;
    }).catch(function () { S.ready = false; return false; });
    return S.loaded;
  }

  /* 设置 / 解锁：检查令牌 → 读远端拿 salt → 用口令派生并试解一份，口令错就停在这里 */
  function setup(o) {
    var cfg = { owner: o.owner || DEF.owner, repo: o.repo || DEF.repo, branch: o.branch || DEF.branch,
                token: (o.token || "").trim(), device: o.device || deviceName() };
    if (!cfg.token) return Promise.reject(new Error("要填 GitHub 令牌"));
    if (!o.password) return Promise.reject(new Error("要填同步口令"));
    if (!window.isSecureContext || !crypto.subtle) return Promise.reject(new Error("要用 https 打开才能加密"));
    var names = o.names || ["budget", "calendar"], found = null;
    return checkRepo(cfg).then(function () {
      return Promise.all(names.map(function (n) { return pull(cfg, n); }));
    }).then(function (rs) {
      rs.forEach(function (r) {
        if (r && !found) { try { found = JSON.parse(r.text); } catch (e) {} }
      });
      if (!found && !o.creating) {
        var e = new Error("远端还没有同步文件。这是第一台设备的话，选「第一次设置」并把口令输两遍。");
        e.code = "fresh";
        throw e;
      }
      if (found && found.format !== FORMAT) throw new Error("远端文件格式不认识");
      if (!found && o.password.length < 10) throw new Error("口令至少 10 个字符；五六个不相关的字拼起来就够强");
      var salt = found ? unb64(found.salt) : crypto.getRandomValues(new Uint8Array(16));
      return derive(o.password, salt, found ? found.iterations : ITER).then(function (key) {
        if (!found) return { key: key, salt: salt };
        return open(key, found).then(function () { return { key: key, salt: salt }; }, function () {
          throw new Error("口令不对");
        });
      });
    }).then(function (k) {
      S.cfg = cfg;
      S.key = k.key;
      S.salt = k.salt;
      S.ready = true;
      S.memOnly = o.remember === false;
      var save = S.memOnly ? Promise.resolve() :
        Promise.all([kset("cfg", cfg), kset("key", k.key), kset("salt", Array.from(k.salt))]);
      return save.then(function () {
        Object.keys(S.stores).forEach(function (n) { S.stores[n].sha = null; kick(n, 0); });
        emitAll();
        return true;
      });
    });
  }
  function forget() {
    S.cfg = null; S.key = null; S.salt = null; S.ready = false; S.dkey = null;
    Object.keys(S.stores).forEach(function (n) { var st = S.stores[n]; st.base = undefined; st.sha = null; st.state = "off"; st.msg = "未设置"; });
    return kclear().then(emitAll);
  }

  /* ------------------------------------------------------------ 同步循环 */
  function attach(name, h) {
    var st = S.stores[name] = S.stores[name] || { name: name, base: undefined, sha: null, running: false, again: false,
                                                    t: null, state: "off", msg: "未设置", last: 0, fails: 0 };
    st.get = h.get;
    st.set = h.set;
    st.normalize = h.normalize || function (d) { return d; };
    /* 本机还什么都没记过（新设备）：第一次同步直接用远端那份，免得把远端删掉的默认分类又并回去 */
    st.isEmpty = h.isEmpty || function (d) {
      return !d || ((!d.tx || !d.tx.length) && (!d.events || !d.events.length) &&
                    (!d.months || !Object.keys(d.months).length) && (!d.recurring || !d.recurring.length));
    };
    Promise.all([load(), getLocal("base:" + name), kget("sha:" + name)]).then(function (a) {
      st.base = a[1];
      st.sha = a[2] || null;
      if (!S.ready) { st.state = "off"; st.msg = "未设置"; emit(st); return; }
      kick(name, 300);
    });
    return st;
  }
  function kick(name, ms) {
    var st = S.stores[name];
    if (!st) return;
    clearTimeout(st.t);
    st.t = setTimeout(function () { run(st); }, ms == null ? 2500 : ms);
  }
  function setState(st, state, msg) { st.state = state; st.msg = msg; emit(st); }
  function run(st) {
    if (!S.ready) { setState(st, "off", "未设置"); return Promise.resolve(); }
    if (!st.get || st.get() == null) return Promise.resolve();
    if (st.running) { st.again = true; return Promise.resolve(); }
    if (!navigator.onLine) { setState(st, "wait", "离线 · 联网后自动同步"); return Promise.resolve(); }
    st.running = true;
    setState(st, "busy", "同步中…");
    return once(st, 0).then(function (r) {
      st.fails = 0;
      st.last = Date.now();
      setState(st, "ok", r);
    }, function (e) {
      st.fails++;
      setState(st, "bad", e.message || String(e));
      if (e.status === 401) return;
      clearTimeout(st.t);
      st.t = setTimeout(function () { run(st); }, Math.min(300000, 15000 * st.fails));
    }).then(function () {
      st.running = false;
      if (st.again) { st.again = false; kick(st.name, 500); }
    });
  }
  function once(st, tries) {
    var cfg = S.cfg, remoteData, remoteSha, local, merged;
    return pull(cfg, st.name).then(function (r) {
      remoteSha = r ? r.sha : null;
      if (!r) return undefined;
      if (r.sha === st.sha && st.base !== undefined) return clone(st.base);
      var env = JSON.parse(r.text);
      if (env.format !== FORMAT) throw new Error("远端文件格式不认识");
      if (env.salt !== b64(S.salt)) {
        var e = new Error("远端文件换过口令，这台设备要重新解锁");
        e.status = 401;
        throw e;
      }
      return open(S.key, env).catch(function () {
        var e = new Error("解不开远端文件，这台设备要重新解锁");
        e.status = 401;
        throw e;
      });
    }).then(function (rd) {
      remoteData = rd === undefined ? undefined : st.normalize(rd);
      local = clone(st.get());
      if (remoteData === undefined) merged = local;
      else if (st.base === undefined && st.isEmpty(local)) merged = clone(remoteData);
      else merged = st.normalize(merge3(st.base, local, remoteData));
      if (!eq(merged, local)) {
        /* 拉取这段时间里本机又改了：把这些新改动再叠上去 */
        var now = clone(st.get());
        if (!eq(now, local)) merged = st.normalize(merge3(local, now, merged));
        st.set(clone(merged));
      }
      if (remoteData !== undefined && eq(merged, remoteData)) return remoteSha;
      return seal(S.key, S.salt, merged, { by: cfg.device }).then(function (env) {
        return push(cfg, st.name, JSON.stringify(env), remoteSha, cfg.device);
      });
    }).then(function (sha) {
      st.base = clone(merged);
      st.sha = sha;
      var done = S.memOnly ? Promise.resolve() : Promise.all([putLocal("base:" + st.name, merged), kset("sha:" + st.name, sha)]);
      return done.then(function () {
        var d = new Date();
        return "已同步 " + p2(d.getHours()) + ":" + p2(d.getMinutes());
      });
    }).catch(function (e) {
      if ((e.status === 409 || e.status === 422) && tries < 3) return once(st, tries + 1);
      throw e;
    });
  }
  function p2(n) { return (n < 10 ? "0" : "") + n; }

  /* 前台每分钟看一眼远端；切回页面、恢复联网时立刻看一眼 */
  setInterval(function () {
    if (document.visibilityState !== "visible") return;
    Object.keys(S.stores).forEach(function (n) {
      var st = S.stores[n];
      if (st.state !== "busy" && Date.now() - st.last > 55000) run(st);
    });
  }, 60000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") Object.keys(S.stores).forEach(function (n) { kick(n, 200); });
  });
  window.addEventListener("online", function () { Object.keys(S.stores).forEach(function (n) { kick(n, 200); }); });

  /* ------------------------------------------------------------ 状态通知 */
  function emit(st) { S.listeners.forEach(function (fn) { try { fn(st.name, st.state, st.msg); } catch (e) {} }); }
  function emitAll() { Object.keys(S.stores).forEach(function (n) { emit(S.stores[n]); }); }
  function onStatus(fn) { S.listeners.push(fn); emitAll(); }

  /* ------------------------------------------------------------ 设置对话框（电脑页面和手机 App 共用） */
  var CSS =
    '.ls-mask{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200;padding:16px}' +
    '.ls-box{background:var(--bg,#fff);color:var(--fg,#111);border:3px solid var(--line,#111);width:min(460px,100%);max-height:92vh;overflow:auto;padding:20px 22px;font:14px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}' +
    '.ls-box h3{margin:0 0 6px;font-size:19px}.ls-box p{margin:6px 0}.ls-box .ls-dim{color:var(--dim,#6b6b6b);font-size:12.5px}' +
    '.ls-box label{display:block;font-weight:700;margin:12px 0 4px}' +
    '.ls-box input[type=text],.ls-box input[type=password]{width:100%;box-sizing:border-box;border:2px solid var(--line,#111);background:var(--bg,#fff);color:var(--fg,#111);padding:8px 10px;font:15px/1.4 ui-monospace,Menlo,Consolas,monospace;border-radius:0}' +
    '.ls-box .ls-chk{display:flex;gap:8px;align-items:center;font-weight:400;margin-top:12px}' +
    '.ls-box .ls-tabs{display:flex;gap:0;margin:10px 0 2px;border:2px solid var(--line,#111)}' +
    '.ls-box .ls-tabs button{flex:1;border:0;background:transparent;color:inherit;padding:7px;font:inherit;cursor:pointer}' +
    '.ls-box .ls-tabs button.on{background:var(--fg,#111);color:var(--bg,#fff)}' +
    '.ls-box .ls-row{display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}' +
    '.ls-box .ls-row button{border:2px solid var(--line,#111);background:var(--bg,#fff);color:var(--fg,#111);padding:7px 16px;font:inherit;cursor:pointer}' +
    '.ls-box .ls-row button.pri{background:var(--fg,#111);color:var(--bg,#fff)}' +
    '.ls-box .ls-err{color:var(--bad,#b42318);min-height:1.2em;margin-top:10px}' +
    '.ls-box details{margin-top:10px}.ls-box summary{cursor:pointer;color:var(--dim,#6b6b6b)}' +
    '.ls-box ol{padding-left:1.3em;margin:6px 0}.ls-box code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}';
  function dialog(opts) {
    opts = opts || {};
    if (!document.getElementById("ls-css")) {
      var s = document.createElement("style");
      s.id = "ls-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    var cfg = S.cfg || {};
    var m = document.createElement("div");
    m.className = "ls-mask";
    m.innerHTML =
      '<div class="ls-box" role="dialog" aria-modal="true">' +
      '<h3>跨设备同步</h3>' +
      '<p class="ls-dim">预算和日程加密后存进仓库的 <code>sync/</code>，手机和电脑都从那里读写。口令不上传，只有你知道。</p>' +
      (S.ready ? '<p>这台设备已经连好（' + esc(cfg.owner + "/" + cfg.repo) + '）。</p>' : '') +
      '<div class="ls-tabs"><button type="button" data-m="join" class="on">这台设备加入</button><button type="button" data-m="new">第一次设置</button></div>' +
      '<label for="ls-tok">GitHub 令牌</label><input id="ls-tok" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…">' +
      '<details><summary>怎么拿令牌</summary><ol>' +
      '<li>电脑上打开 github.com → 右上头像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token。</li>' +
      '<li>Repository access 选 Only select repositories，只勾 <code>' + esc(DEF.repo) + '</code>。</li>' +
      '<li>Permissions → Repository permissions → Contents 选 Read and write，其余不动。</li>' +
      '<li>有效期可以设一年；生成后复制，粘到这里。手机上可以用「隔空投送」或备忘录把它传过去。</li></ol></details>' +
      '<label for="ls-pw">同步口令</label><input id="ls-pw" type="password" autocomplete="new-password" spellcheck="false">' +
      '<div id="ls-pw2w" hidden><label for="ls-pw2">再输一遍</label><input id="ls-pw2" type="password" autocomplete="new-password" spellcheck="false">' +
      '<p class="ls-dim">口令忘了就解不开，谁也帮不了你。至少 10 个字符，建议几个不相关的词拼起来。</p></div>' +
      '<details><summary>仓库（一般不用改）</summary><label for="ls-repo">owner/repo@branch</label>' +
      '<input id="ls-repo" type="text" spellcheck="false" value="' + esc((cfg.owner || DEF.owner) + "/" + (cfg.repo || DEF.repo) + "@" + (cfg.branch || DEF.branch)) + '"></details>' +
      '<label class="ls-chk"><input type="checkbox" id="ls-rem" checked> 记住这台设备（下次不用再输）</label>' +
      '<div class="ls-err" id="ls-err"></div>' +
      '<div class="ls-row">' + (S.ready ? '<button type="button" id="ls-forget">忘掉这台设备</button>' : '') +
      '<button type="button" id="ls-no">' + (opts.mandatory ? "稍后" : "取消") + '</button><button type="button" class="pri" id="ls-ok">连接</button></div></div>';
    document.body.appendChild(m);
    var mode = "join";
    function q(id) { return m.querySelector("#" + id); }
    [].forEach.call(m.querySelectorAll(".ls-tabs button"), function (b) {
      b.addEventListener("click", function () {
        mode = b.dataset.m;
        [].forEach.call(m.querySelectorAll(".ls-tabs button"), function (x) { x.classList.toggle("on", x === b); });
        q("ls-pw2w").hidden = mode !== "new";
        q("ls-ok").textContent = mode === "new" ? "创建并连接" : "连接";
      });
    });
    return new Promise(function (resolve) {
      function close(v) { m.remove(); resolve(v); }
      q("ls-no").addEventListener("click", function () { close(false); });
      if (q("ls-forget")) q("ls-forget").addEventListener("click", function () {
        if (!window.confirm("删掉这台设备上存的令牌和密钥？远端数据不受影响。")) return;
        forget().then(function () { close("forgot"); });
      });
      q("ls-ok").addEventListener("click", function () {
        var err = q("ls-err"), btn = q("ls-ok");
        var repo = q("ls-repo").value.trim().match(/^([\w.-]+)\/([\w.-]+?)(?:@([\w./-]+))?$/);
        if (!repo) { err.textContent = "仓库写成 owner/repo@branch"; return; }
        if (mode === "new" && q("ls-pw").value !== q("ls-pw2").value) { err.textContent = "两遍口令不一样"; return; }
        err.textContent = "";
        btn.disabled = true;
        btn.textContent = "派生密钥中…（故意慢）";
        setup({ token: q("ls-tok").value, password: q("ls-pw").value, owner: repo[1], repo: repo[2], branch: repo[3] || "main",
                creating: mode === "new", remember: q("ls-rem").checked }).then(function () {
          close(true);
        }, function (e) {
          btn.disabled = false;
          btn.textContent = mode === "new" ? "创建并连接" : "连接";
          err.textContent = e.message || String(e);
          if (e.code === "fresh") m.querySelector('.ls-tabs button[data-m="new"]').click();
        });
      });
      setTimeout(function () { q(S.cfg && S.cfg.token ? "ls-pw" : "ls-tok").focus(); }, 0);
      if (S.cfg && S.cfg.token) q("ls-tok").value = S.cfg.token;
    });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* 电脑页面的顶栏小按钮：显示同步状态，点开设置 */
  function badge(names) {
    var host = document.querySelector("header");
    var anchor = document.getElementById("btnTheme");
    if (!host || !anchor) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "mini";
    b.id = "ls-badge";
    b.textContent = "同步：…";
    host.insertBefore(b, anchor);
    function paint() {
      var worst = null, msg = "";
      (names || Object.keys(S.stores)).forEach(function (n) {
        var st = S.stores[n];
        if (!st) return;
        var rank = { bad: 4, off: 3, wait: 2, busy: 1, ok: 0 }[st.state] || 0;
        if (worst === null || rank > worst.r) worst = { r: rank, st: st };
        msg += (msg ? "；" : "") + n + "：" + st.msg;
      });
      if (!worst) return;
      var st = worst.st;
      b.textContent = st.state === "off" ? "同步：未设置" : st.state === "bad" ? "同步：出错" :
                      st.state === "busy" ? "同步中…" : st.state === "wait" ? "同步：离线" : "同步 ✓";
      b.title = msg;
      b.style.color = st.state === "bad" ? "var(--bad)" : "";
    }
    onStatus(paint);
    b.addEventListener("click", function () {
      if (S.ready) Object.keys(S.stores).forEach(function (n) { kick(n, 0); });
      dialog();
    });
  }

  window.LabSync = {
    attach: attach, kick: kick, setup: setup, forget: forget, dialog: dialog, badge: badge, onStatus: onStatus,
    ready: function () { return load().then(function () { return S.ready; }); },
    isReady: function () { return S.ready; },
    putLocal: putLocal, getLocal: getLocal,
    syncNow: function (name) { var st = S.stores[name]; return st ? run(st) : Promise.resolve(); },
    _merge3: merge3, _eq: eq
  };
})();
