/* 把实验室原本的 /api/* 本机判题接口，在浏览器里换成 wandbox.org。
   只在 localStorage['lab-online']==='1' 时接管，否则原样放行（走本机服务或离线模式）。
   代价：每个测试点一次编译（一题 10 个点 = 10 次请求）、没有毫秒计时、
   题目的 1 秒限制不生效（超时按 Wandbox 自己的上限判），代码会发给第三方。 */
(function () {
  'use strict';
  if (localStorage.getItem("lab-online") !== "1") return;

  var API = "https://wandbox.org/api/compile.json";
  var COMPILER = "gcc-13.2.0";
  var SWITCHES = "-std=c++17,-O2";
  var real = window.fetch.bind(window);
  var lastCode = null;

  function res(obj, text) {
    return new Response(text != null ? text : JSON.stringify(obj), {
      status: 200,
      headers: { "Content-Type": text != null ? "text/plain" : "application/json" }
    });
  }
  var INFRA = /OCI runtime error|Resource temporarily|Too Many Requests|rate.?limit|502|503|504/i;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function send(code, stdin, tries) {
    tries = tries || 0;
    return real(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        compiler: COMPILER, code: code, stdin: stdin || "",
        filename: "main.cpp", switches: SWITCHES, save: false
      })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (tries < 3 && INFRA.test((j.compiler_error || "") + (j.program_error || ""))) {
        return sleep(1200 * (tries + 1)).then(function () { return send(code, stdin, tries + 1); });
      }
      return j;
    });
  }
  function infraNote(j) {
    return "在线编译服务暂时不可用（Wandbox 繁忙，已重试 3 次），稍后再试或改用本机判题。\n" +
           (j.compiler_error || "").trim();
  }
  function verdict(j) {
    var cerr = (j.compiler_error || "").trim();
    if (cerr && INFRA.test(cerr)) {
      return { status: "IE", ms: 0, out: "", err: infraNote(j), code: j.status };
    }
    if (cerr) {
      return { status: "CE", ms: 0, out: "", err: cerr, code: j.status };
    }
    var sig = j.signal || "", status = Number(j.status);
    if (/XCPU|XFSZ/.test(sig) || status === 124) return { status: "TLE", ms: 0, out: j.program_output || "", err: j.program_error || "", code: status };
    if (sig) return { status: "RE", ms: 0, out: j.program_output || "", err: (j.program_error || "") + "\n信号 " + sig, code: status };
    if (status !== 0) return { status: "RE", ms: 0, out: j.program_output || "", err: j.program_error || "", code: status };
    return { status: "OK", ms: 0, out: j.program_output || "", err: j.program_error || "", code: 0 };
  }

  window.fetch = function (url, opt) {
    var u = String(url);
    if (u.indexOf("/ping") >= 0) return Promise.resolve(res(null, "cpplab2"));
    if (u.indexOf("/api/config") >= 0) {
      if (opt && opt.method === "POST") return Promise.resolve(res({ ok: true }));
      return Promise.resolve(res({
        compiler: "g++ " + COMPILER + " @wandbox", flags: "-std=c++17 -O2",
        dir: "在线", detected: false, online: true
      }));
    }
    if (u.indexOf("/api/progress") >= 0) return Promise.resolve(res({ ok: true }));
    if (u.indexOf("/api/compile") >= 0) {
      var code = (opt && opt.body) || "";
      return send(code, "").then(function (j) {
        lastCode = code;
        var cerr = (j.compiler_error || "").trim();
        if (!cerr) return res({ ok: true });
        return res({ ok: false, log: INFRA.test(cerr) ? infraNote(j) : cerr, start: true });
      });
    }
    if (u.indexOf("/api/run") >= 0) {
      var stdin = (opt && opt.body) || "";
      var src = lastCode != null ? lastCode : "";
      return send(src, stdin).then(function (j) { return res(verdict(j)); });
    }
    return real(url, opt);
  };

  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("banner");
    if (!b) return;
    b.textContent = "在线判题模式：代码提交到 wandbox.org 编译运行。每个测试点单独编译，一题 10 个点要等 20–40 秒；" +
      "没有毫秒计时，题目里的时限不生效，超时按 Wandbox 的上限判。";
    b.classList.add("show");
  });
})();
