/* 记账的「进料口」，电脑预算页和手机 App 共用：
   · readFile(file)：读支付宝 / 微信导出的账单（csv 或 xlsx；支付宝的 csv 是 GBK 编码也认），
     统一成 { d, t, amt(分), kind, merchant, goods, src, ref, type } 一行一笔。
   · parseOcr(text)：快捷指令截图识别出来的文字 → 金额、商家、日期、来源。
   · guessCat(...)：按以前同一商家记过的分类、再按关键词猜分类。
   不碰账本本身，去重和写入由页面决定。 */
(function () {
  'use strict';

  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); }
  function cents(s) {
    var m = String(s == null ? "" : s).replace(/[,，\s]/g, "").match(/-?\d+(?:\.\d{1,2})?/);
    return m ? Math.round(Math.abs(parseFloat(m[0])) * 100) : NaN;
  }
  function normDate(s) {
    var m = String(s || "").match(/(\d{4})\s*[-年\/.]\s*(\d{1,2})\s*[-月\/.]\s*(\d{1,2})/);
    if (!m) return "";
    var d = m[1] + "-" + p2(+m[2]) + "-" + p2(+m[3]);
    var o = new Date(+m[1], +m[2] - 1, +m[3]);
    return ymd(o) === d ? d : "";
  }
  function normTime(s) {
    var m = String(s || "").match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?::\d{2})?/);
    return m && +m[1] < 24 ? p2(+m[1]) + ":" + m[2] : "";
  }

  /* ------------------------------------------------------------ 读文件 */
  function decodeText(buf) {
    var u = new Uint8Array(buf);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(u).replace(/^\ufeff/, ""); }
    catch (e) {
      try { return new TextDecoder("gb18030").decode(u); } catch (e2) { return new TextDecoder("gbk").decode(u); }
    }
  }
  function parseCsv(text) {
    var rows = [], row = [], cell = "", q = false, ch, i;
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
    return rows.map(function (r) { return r.map(function (c) { return c.replace(/^\s+|\s+$/g, "").replace(/^\t+/, ""); }); })
      .filter(function (r) { return r.some(function (c) { return c; }); });
  }

  /* xlsx = zip 包里的几份 xml。只读第一张表，够账单用了。 */
  function u16(a, o) { return a[o] | (a[o + 1] << 8); }
  function u32(a, o) { return (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0; }
  function unzip(buf) {
    var a = new Uint8Array(buf), files = {}, eocd = -1;
    for (var i = a.length - 22; i >= Math.max(0, a.length - 66000); i--) {
      if (u32(a, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是有效的 xlsx（也可能是加了密码的压缩包，先解压）");
    var n = u16(a, eocd + 10), off = u32(a, eocd + 16);
    for (var k = 0; k < n; k++) {
      if (u32(a, off) !== 0x02014b50) break;
      var method = u16(a, off + 10), csize = u32(a, off + 20), nlen = u16(a, off + 28),
          xlen = u16(a, off + 30), clen = u16(a, off + 32), lo = u32(a, off + 42);
      var name = new TextDecoder().decode(a.subarray(off + 46, off + 46 + nlen));
      var start = lo + 30 + u16(a, lo + 26) + u16(a, lo + 28);
      files[name] = { method: method, data: a.subarray(start, start + csize) };
      off += 46 + nlen + xlen + clen;
    }
    return files;
  }
  function inflate(f) {
    if (!f) return Promise.resolve("");
    if (f.method === 0) return Promise.resolve(new TextDecoder().decode(f.data));
    if (typeof DecompressionStream !== "function") return Promise.reject(new Error("这个浏览器解不了 xlsx，在电脑上导入，或者让账单导出成 csv"));
    var s = new Blob([f.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(s).text();
  }
  function colIdx(ref) {
    var m = String(ref || "").match(/^([A-Z]+)/), n = 0;
    if (!m) return -1;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
  }
  function xmlText(el) { return el ? el.textContent : ""; }
  function readXlsx(buf) {
    var files = unzip(buf);
    var sheet = Object.keys(files).filter(function (k) { return /^xl\/worksheets\/sheet\d*\.xml$/.test(k); }).sort()[0];
    if (!sheet) throw new Error("xlsx 里没有表格");
    return Promise.all([inflate(files["xl/sharedStrings.xml"]), inflate(files[sheet])]).then(function (x) {
      var P = new DOMParser(), ss = [];
      if (x[0]) {
        var sd = P.parseFromString(x[0], "application/xml");
        [].forEach.call(sd.getElementsByTagName("si"), function (si) {
          var t = "";
          [].forEach.call(si.getElementsByTagName("t"), function (e) { t += e.textContent; });
          ss.push(t);
        });
      }
      var doc = P.parseFromString(x[1], "application/xml"), rows = [];
      [].forEach.call(doc.getElementsByTagName("row"), function (r) {
        var out = [];
        [].forEach.call(r.getElementsByTagName("c"), function (c, j) {
          var i = colIdx(c.getAttribute("r"));
          if (i < 0) i = j;
          var t = c.getAttribute("t"), v = xmlText(c.getElementsByTagName("v")[0]), val;
          if (t === "s") val = ss[+v] || "";
          else if (t === "inlineStr") val = xmlText(c.getElementsByTagName("t")[0]);
          else val = v;
          /* 日期如果存成了 Excel 序号，换回文字 */
          if (/^\d{5}(\.\d+)?$/.test(val) && i === 0) {
            var ms = Math.round((+val - 25569) * 864e5), d = new Date(ms);
            val = d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate()) + " " + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
          }
          out[i] = String(val == null ? "" : val).trim();
        });
        for (var k = 0; k < out.length; k++) if (out[k] === undefined) out[k] = "";
        if (out.some(function (c) { return c; })) rows.push(out);
      });
      return rows;
    });
  }

  /* 支付宝 / 微信的表头各版本不同，按列名找 */
  var COLS = {
    time: /^(交易时间|交易创建时间|付款时间|创建时间)$/,
    type: /^(交易分类|交易类型|类型)$/,
    party: /^交易对方$/,
    goods: /^(商品说明|商品名称|商品)$/,
    io: /^收\/支$/,
    amt: /^金额/,
    method: /^(收\/付款方式|支付方式|付款方式)$/,
    status: /^(交易状态|当前状态)$/,
    ref: /^(交易订单号|交易单号|交易号)$/,
    note: /^备注$/
  };
  function fromRows(rows, hint) {
    var hi = -1, col = {};
    for (var i = 0; i < Math.min(rows.length, 60); i++) {
      var r = rows[i];
      if (r.some(function (c) { return /^(交易时间|交易创建时间)$/.test(c); }) && r.some(function (c) { return /^金额/.test(c); })) { hi = i; break; }
    }
    if (hi < 0) return null;
    rows[hi].forEach(function (h, j) {
      h = h.replace(/\s+/g, "");
      Object.keys(COLS).forEach(function (k) { if (!(k in col) && COLS[k].test(h)) col[k] = j; });
    });
    var head = rows.slice(0, hi).map(function (r) { return r.join(" "); }).join(" ");
    var src = /微信/.test(head + hint) || "交易单号" === (rows[hi][col.ref] || "") ? "微信" :
              /支付宝|alipay/i.test(head + hint) || "交易订单号" === (rows[hi][col.ref] || "") ? "支付宝" : "账单";
    var out = [], skipped = 0;
    rows.slice(hi + 1).forEach(function (r) {
      function g(k) { return k in col ? (r[col[k]] || "").trim() : ""; }
      var d = normDate(g("time")), amt = cents(g("amt")), io = g("io"), st = g("status");
      if (!d || !amt) { if (r.join("").trim() && !/^-+$/.test(r.join(""))) skipped++; return; }
      if (/关闭|失败|撤销/.test(st) || /全额退款/.test(st)) { skipped++; return; }
      var kind = /收入/.test(io) ? "in" : /支出/.test(io) ? "out" : "";
      if (!kind) { skipped++; return; }                      /* 不计收支：转账到自己、理财、退款回原路等 */
      var m = st.match(/已退款[^\d]*(\d+(?:\.\d+)?)/);
      if (m && kind === "out") { amt -= Math.round(parseFloat(m[1]) * 100); if (amt <= 0) { skipped++; return; } }
      out.push({ d: d, t: normTime(g("time")), amt: amt, kind: kind, merchant: g("party").replace(/^\/$/, ""),
                 goods: g("goods").replace(/^\/$/, ""), type: g("type"), method: g("method"), src: src,
                 ref: g("ref").replace(/\s+/g, ""), note: g("note").replace(/^\/$/, "") });
    });
    return { rows: out, src: src, skipped: skipped };
  }
  function readFile(file) {
    return new Promise(function (ok, no) {
      var rd = new FileReader();
      rd.onload = function () { ok(rd.result); };
      rd.onerror = function () { no(rd.error || new Error("读不了这个文件")); };
      rd.readAsArrayBuffer(file);
    }).then(function (buf) {
      var a = new Uint8Array(buf);
      if (a[0] === 0x50 && a[1] === 0x4b) return readXlsx(buf);
      return parseCsv(decodeText(buf));
    }).then(function (rows) {
      var r = fromRows(rows, file.name || "");
      if (r) r.raw = null;
      return r || { rows: null, raw: rows };
    });
  }

  /* ------------------------------------------------------------ 截图文字 */
  var STATUS = /^(支付成功|交易成功|付款成功|完成|账单详情|全部账单|当前状态|支付时间|创建时间|返回|更多|订单详情|交易详情|收款成功|已支付|待支付|×|<|〈|‹|Q|查看账单|分享)$/;
  function parseOcr(text) {
    var lines = String(text || "").split(/\r?\n/).map(function (s) { return s.replace(/\s+/g, " ").trim(); })
      .filter(function (s) { return s; });
    var all = lines.join("\n"), res = { amt: NaN, kind: "out", merchant: "", goods: "", d: "", t: "", src: "", method: "" };
    if (/支付宝|花呗|余额宝|蚂蚁|网商/.test(all)) res.src = "支付宝";
    else if (/微信|零钱|财付通/.test(all)) res.src = "微信";

    /* 金额：带 ¥ 或正负号、两位小数的优先；状态栏时间和单号不会长这样 */
    var best = null;
    lines.forEach(function (ln, i) {
      var re = /([¥￥]|[-−–+])\s*(\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?)(?!\d)/g, m;
      while ((m = re.exec(ln))) {
        var v = parseFloat(m[2].replace(/,/g, "")), score = 0;
        if (/\.\d{2}$/.test(m[2])) score += 2;
        if (/[¥￥]/.test(m[1])) score += 2;
        if (/^[-−–+]/.test(m[1])) score += 1;
        if (ln.replace(m[0], "").trim() === "") score += 2;         /* 单独一行的大字金额 */
        if (/优惠|立减|红包|手续费|余额|积分|原价/.test(ln)) score -= 4;
        if (!best || score > best.score) best = { v: v, sign: m[1], score: score, i: i };
      }
      var y = ln.match(/^(\d{1,7}(?:\.\d{2}))\s*元$/);
      if (y && (!best || best.score < 3)) best = { v: parseFloat(y[1]), sign: "", score: 3, i: i };
    });
    if (best) {
      res.amt = Math.round(best.v * 100);
      if (best.sign === "+") res.kind = "in";
    }
    if (/收款到账|已收款|收入|退款到账/.test(all) && !/支出/.test(all) && best && best.sign !== "-") res.kind = "in";

    /* 日期时间：优先「支付时间 / 创建时间」那一行 */
    var dl = lines.filter(function (s) { return /支付时间|创建时间|付款时间|交易时间|到账时间/.test(s); })[0] || "";
    var dl2 = dl || lines.filter(function (s) { return normDate(s); })[0] || "";
    if (dl && !normDate(dl)) {
      var j = lines.indexOf(dl);
      if (lines[j + 1] && normDate(lines[j + 1])) dl2 = lines[j + 1];
    }
    res.d = normDate(dl2);
    if (dl2) res.t = normTime(dl2.replace(/\d{4}\s*[-年\/.]\s*\d{1,2}\s*[-月\/.]\s*\d{1,2}\s*日?/, ""));

    /* 商家：有标签就用标签后面的，没有就取金额上一行 */
    function labelled(re) {
      for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(re);
        if (m) {
          var v = (m[1] || "").trim();
          if (!v && lines[i + 1]) v = lines[i + 1];
          if (v) return v;
        }
      }
      return "";
    }
    res.goods = labelled(/^(?:商品说明|商品名称|商品)[:：\s]*(.*)$/);
    res.method = labelled(/^(?:付款方式|支付方式)[:：\s]*(.*)$/);
    var named = labelled(/^(?:收款方全称|商户全称|收款方|交易对方|对方账户|商户名称|商家)[:：\s]*(.*)$/);
    var near = "";
    if (best) {
      for (var k = best.i - 1; k >= 0 && k >= best.i - 3; k--) {
        var s = lines[k];
        if (STATUS.test(s) || /^\d{1,2}:\d{2}/.test(s) || /^[\d\s:.%]+$/.test(s) || s.length > 40) continue;
        if (/[¥￥]/.test(s)) continue;
        near = s;
        break;
      }
      if (!near && lines[best.i].replace(/([¥￥]|[-−–+])\s*[\d,.]+/, "").trim().length > 1) {
        near = lines[best.i].replace(/([¥￥]|[-−–+])\s*[\d,.]+/, "").trim();
      }
    }
    res.merchant = (near && !/^(支付宝|微信支付)$/.test(near) ? near : "") || named || res.goods;
    if (named && named.length < 30 && (!res.merchant || res.merchant === res.goods)) res.merchant = named;
    res.merchant = res.merchant.replace(/[>›〉]\s*$/, "").trim().slice(0, 40);
    return res;
  }

  /* ------------------------------------------------------------ 猜分类 */
  var KW = [
    ["food", "吃饭", /餐饮|美食|外卖|美团|饿了么|肯德基|KFC|麦当劳|汉堡王|必胜客|星巴克|瑞幸|库迪|咖啡|奶茶|蜜雪|喜茶|茶百道|古茗|霸王茶姬|奈雪|食堂|餐厅|饭|面馆|面|粉|烧烤|火锅|小吃|水果|面包|烘焙|零食|饮品|早餐|午餐|晚餐|夜宵/i],
    ["trans", "交通", /交通|出行|滴滴|地铁|公交|12306|铁路|高铁|火车|高德|打车|加油|中石化|中石油|停车|航空|机票|航旅|哈啰|青桔|美团单车|共享单车|出租|ETC|曹操|T3/i],
    ["rent", "房租水电", /住房|物业|房租|租金|水费|电费|燃气|话费|充值缴费|生活缴费|宽带|国家电网|自来水|移动|联通|电信/],
    ["study", "学习", /教育|培训|书店|图书|当当|知网|文具|打印|复印|课程|学费|考试|报名|网课|Kindle|得到/i],
    ["fun", "娱乐", /娱乐|休闲|电影|猫眼|淘票票|游戏|Steam|视频会员|爱奇艺|腾讯视频|优酷|bilibili|哔哩|B站|网易云|QQ音乐|KTV|演出|门票|景区|旅游|健身|运动/i],
    ["daily", "日用", /日用|百货|超市|便利|淘宝|天猫|京东|拼多多|名创|屈臣氏|药房|药店|医院|理发|洗衣|快递|顺丰|盒马|山姆|永辉|沃尔玛|家乐福|罗森|全家|7-?11/i]
  ];
  function guessCat(text, cats, learned) {
    text = String(text || "");
    cats = cats || [];
    if (learned) {
      var keys = Object.keys(learned).sort(function (a, b) { return b.length - a.length; });
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].length >= 2 && text.indexOf(keys[i]) >= 0 && cats.some(function (c) { return c.id === learned[keys[i]]; })) return learned[keys[i]];
      }
    }
    for (var j = 0; j < KW.length; j++) {
      if (!KW[j][2].test(text)) continue;
      var c = cats.filter(function (x) { return x.id === KW[j][0] || x.name === KW[j][1]; })[0];
      if (c) return c.id;
    }
    return "";
  }
  /* 从已有流水学「商家 → 分类」：同一个备注最后一次用的分类 */
  function learn(tx) {
    var m = {};
    (tx || []).forEach(function (t) {
      if (t.kind === "in" || !t.cat) return;
      var key = (t.note || "").split(" · ")[0].trim();
      if (key) m[key] = t.cat;
    });
    return m;
  }

  /* 账单行和已有流水对账：同一单号算重复；没单号的按「同一天前后一天、同金额、同收支」认成同一笔 */
  function reconcile(rows, tx) {
    var byRef = {}, loose = [], res = { add: [], match: [], dup: 0 };
    tx.forEach(function (t) {
      if (t.ref) byRef[t.ref] = t;
      else loose.push(t);
    });
    rows.forEach(function (r) {
      if (r.ref && byRef[r.ref]) { res.dup++; return; }
      var hit = null;
      for (var i = 0; i < loose.length; i++) {
        var t = loose[i];
        if (t.amt === r.amt && t.kind === r.kind && Math.abs(new Date(t.d) - new Date(r.d)) <= 864e5) { hit = t; loose.splice(i, 1); break; }
      }
      if (hit) { res.match.push({ tx: hit, row: r }); if (r.ref) byRef[r.ref] = hit; return; }
      res.add.push(r);
      if (r.ref) byRef[r.ref] = r;
    });
    return res;
  }

  window.Bills = { readFile: readFile, fromRows: fromRows, parseCsv: parseCsv, parseOcr: parseOcr,
                   guessCat: guessCat, learn: learn, reconcile: reconcile, normDate: normDate };
})();
