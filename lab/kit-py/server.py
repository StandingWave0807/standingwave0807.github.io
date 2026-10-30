#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Python 生活实验室 —— 本地判题服务（纯 Python 标准库，不装任何依赖）

只做一件事：把 https://phenolforever.com/lab/pylab.html 的判题请求接到你机器上的 Python。
页面本身从网站打开，这个服务不发送网页，只执行解释器并比对输出。

接口（与原启动器一致）：
    GET  /ping             -> "pylab"
    GET  /api/config       -> {python, flags, detected[], dir}
    POST /api/config       -> body "解释器路径\\n附加参数"
    GET  /api/progress     -> 进度 JSON
    POST /api/progress     -> 保存进度 JSON
    POST /api/selftest     -> body = 一段 python; 回 {ok, out, ms, log, version}
    POST /api/compile      -> body = 源代码; 回 {ok, job, log}
    POST /api/case?id=&i=&job=&tl=  -> 服务端取第 i 组隐藏测试跑并比对;
                                       回 {status, ac, ms, code, out, err, exp, inp}
    POST /api/custom?job=&tl=       -> body = 标准输入; 回 {status, ms, code, out, err}

隐藏测试点在同目录 data/tests/chNN.json（334 题 4145 组）。没有这个目录，
自测运行和样例仍可用，「提交评测」会提示找不到测试。

只监听 127.0.0.1：局域网里的其他人连不上，也不会经过任何服务器。
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
TDIR = os.path.join(ROOT, "data", "tests")
DATA = os.path.join(ROOT, "data")
CFG = os.path.join(ROOT, "config.json")

SITE = "https://phenolforever.com/lab/pylab.html"
PORT = 8642
TOKEN = "pylab"

LOCK = threading.Lock()
JOBS = {}
TESTS = {}

LOC = re.compile(r"第\s*\d+\s*行\s*第\s*\d+\s*列")
CREATE_NO_WINDOW = 0x08000000
CREATIONFLAGS = CREATE_NO_WINDOW if os.name == "nt" else 0


# --------------------------------------------------------------------------- #
# 比对口径：行尾空白和末尾空行不算差异；locpair 题把「第 X 行第 Y 列」折成占位
# --------------------------------------------------------------------------- #
def norm(s):
    s = (s or "").replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(l.rstrip() for l in s.split("\n")).rstrip("\n")


def same(out, exp, tol):
    if tol == "locpair":
        return LOC.sub("第X行第Y列", norm(out)) == LOC.sub("第X行第Y列", norm(exp))
    return norm(out) == norm(exp)


def cut(s, n):
    s = s or ""
    return s if len(s) <= n else s[:n] + "\n…（已截断）"


def trim_pycache(log):
    return re.sub(r'File "[^"]*main\.py"', 'File "main.py"', log or "")


# --------------------------------------------------------------------------- #
# 解释器与配置
# --------------------------------------------------------------------------- #
def default_python():
    exe = sys.executable or ""
    d = os.path.dirname(exe)
    name = os.path.basename(exe).lower()
    if name.startswith("pythonw"):
        cand = os.path.join(d, name.replace("pythonw", "python"))
        if os.path.exists(cand):
            return cand
    return exe or "python"


def detected():
    out, seen = [], set()
    for c in [default_python(), shutil.which("python"), shutil.which("python3"), shutil.which("py")]:
        if c and c not in seen and os.path.exists(c):
            seen.add(c)
            out.append(c)
    for d in ("C:/Python313", "C:/Python312", "C:/Python314", "C:/Python311",
              os.path.expandvars(r"%LOCALAPPDATA%\Programs\Python\Python313"),
              os.path.expandvars(r"%LOCALAPPDATA%\Programs\Python\Python312")):
        p = os.path.join(d, "python.exe")
        if os.path.exists(p) and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def load_cfg():
    c = {}
    try:
        with open(CFG, encoding="utf-8") as f:
            c = json.load(f)
    except Exception:
        c = {}
    if not c.get("python") or not os.path.exists(c["python"]):
        det = detected()
        c["python"] = det[0] if det else default_python()
    c.setdefault("flags", "")
    return c


def save_cfg(c):
    try:
        os.makedirs(DATA, exist_ok=True)
        tmp = CFG + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(c, f, ensure_ascii=False)
        os.replace(tmp, CFG)
    except Exception:
        pass


def load_progress():
    c = {}
    try:
        with open(CFG, encoding="utf-8") as f:
            c = json.load(f)
    except Exception:
        pass
    return c.get("progress") or {}


# --------------------------------------------------------------------------- #
# 测试点
# --------------------------------------------------------------------------- #
def tests_of(pid):
    ch = pid[2:4]
    with LOCK:
        if ch in TESTS:
            return TESTS[ch]
    path = os.path.join(TDIR, "ch%s.json" % ch)
    data = {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    with LOCK:
        TESTS[ch] = data
    return data


# --------------------------------------------------------------------------- #
# 运行
# --------------------------------------------------------------------------- #
def run_py(code_bytes, stdin_text, tl_ms, cfg):
    d = tempfile.mkdtemp(prefix="plrun_")
    try:
        src = os.path.join(d, "main.py")
        with open(src, "wb") as f:
            f.write(code_bytes)
        args = [cfg["python"], "-X", "utf8"] + [a for a in (cfg.get("flags") or "").split() if a] + [src]
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        t0 = time.time()
        try:
            p = subprocess.run(args, input=(stdin_text or "").encode("utf-8"),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=max(0.3, tl_ms / 1000.0), cwd=d, env=env,
                               creationflags=CREATIONFLAGS)
        except subprocess.TimeoutExpired:
            return {"status": "TLE", "ms": (time.time() - t0) * 1000, "out": "", "err": "", "code": -1}
        except OSError as e:
            return {"status": "SE", "ms": 0.0, "out": "", "err": "解释器无法启动：%s" % e, "code": -1}
        ms = (time.time() - t0) * 1000
        return {"status": "OK" if p.returncode == 0 else "RE", "ms": ms,
                "out": p.stdout.decode("utf-8", "replace"),
                "err": p.stderr.decode("utf-8", "replace").strip(), "code": p.returncode}
    finally:
        shutil.rmtree(d, ignore_errors=True)


def job_dir(key):
    with LOCK:
        d = JOBS.get(key)
    if d and os.path.isdir(d):
        return d
    return None


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
LANDING = """<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8">
<title>Python 生活实验室 · 本地判题服务</title>
<body style="font:16px/1.8 system-ui;margin:48px;max-width:40em">
<h2>判题服务已经在跑</h2>
<p>这个服务不提供网页，只执行解释器。题目在网站上：
<a href="%s">%s</a></p>
<p>关掉本服务的窗口即停止。</p>
</body></html>""" % (SITE, SITE)


class Handler(BaseHTTPRequestHandler):
    server_version = "PyLabJudge/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        # 页面在 https://phenolforever.com，请求打到这里属于「公网页面访问本机端口」：
        # 浏览器会先发一个私有网络预检，必须回 Allow-Private-Network 才放行。
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def send_json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def do_OPTIONS(self):
        self.body()
        self.send_response(204)
        self.send_header("Allow", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         self.headers.get("Access-Control-Request-Headers") or "*")
        self.send_header("Access-Control-Max-Age", "86400")
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        return self.rfile.read(n).decode("utf-8", "replace") if n else ""

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path.rstrip("/") or "/"
        if p == "/ping":
            return self._send(200, TOKEN)
        if p == "/api/config":
            c = load_cfg()
            return self.send_json({"python": c["python"], "flags": c.get("flags", ""),
                                   "detected": detected(), "dir": ROOT})
        if p == "/api/progress":
            return self.send_json(load_progress())
        if p == "/api/tests":
            q = parse_qs(u.query)
            ch = (q.get("ch") or [""])[0]
            if not re.match(r"^\d{2}$", ch):
                return self.send_json({"error": "ch 要写成两位章号"}, 400)
            d = tests_of("pl%s-1" % ch)
            return self.send_json({"ch": ch, "problems": len(d),
                                   "tests": sum(len(v.get("tests", [])) for v in d.values())})
        if p == "/api/quit":
            self._send(200, "bye")
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if p in ("/", "/index.html"):
            return self._send(200, LANDING, "text/html; charset=utf-8")
        return self._send(404, "not found")

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path.rstrip("/")
        raw = self.body()
        c = load_cfg()

        if p == "/api/config":
            lines = raw.split("\n")
            c["python"] = (lines[0] or "").strip().strip('"') or default_python()
            c["flags"] = (lines[1] if len(lines) > 1 else "").strip()
            save_cfg(c)
            return self.send_json({"ok": True, "python": c["python"]})
        if p == "/api/progress":
            try:
                c["progress"] = json.loads(raw or "{}")
            except Exception:
                pass
            save_cfg(c)
            return self.send_json({"ok": True})
        if p == "/api/selftest":
            t0 = time.time()
            r = run_py((raw or "print(1+2)").encode("utf-8"), "", 5000, c)
            return self.send_json({"ok": r["status"] == "OK", "out": r["out"],
                                   "ms": (time.time() - t0) * 1000, "log": r["err"],
                                   "version": (r["err"] or "").strip()})
        if p == "/api/compile":
            code = raw.encode("utf-8")
            key = hashlib.sha1(code).hexdigest()[:16]
            d = job_dir(key)
            if not d:
                d = tempfile.mkdtemp(prefix="pljob_")
                with open(os.path.join(d, "main.py"), "wb") as f:
                    f.write(code)
                with LOCK:
                    JOBS[key] = d
                with LOCK:
                    while len(JOBS) > 10:
                        for k in list(JOBS)[:len(JOBS) - 10]:
                            shutil.rmtree(JOBS.pop(k), ignore_errors=True)
            try:
                r = subprocess.run([c["python"], "-m", "py_compile", os.path.join(d, "main.py")],
                                   capture_output=True, cwd=d,
                                   env=dict(os.environ, PYTHONIOENCODING="utf-8"),
                                   creationflags=CREATIONFLAGS)
                log = r.stderr.decode("utf-8", "replace")
                ok = r.returncode == 0 and not log.strip()
            except OSError as e:
                log, ok = "解释器无法启动：%s" % e, False
            if ok:
                return self.send_json({"ok": True, "job": key, "log": ""})
            return self.send_json({"ok": False, "job": key,
                                   "nopython": not os.path.exists(c["python"]),
                                   "log": trim_pycache(log)})
        m = re.match(r"^/api/(case|custom)$", p)
        if m:
            q = parse_qs(urlparse(self.path).query)
            key = (q.get("job") or [""])[0]
            d = job_dir(key)
            if not d:
                return self.send_json({"status": "SE", "ms": 0, "out": "", "code": -1,
                                       "err": "判题作业已失效：重新点一次提交即可。"})
            code = open(os.path.join(d, "main.py"), "rb").read()
            try:
                tl = int(float((q.get("tl") or ["2000"])[0]))
            except ValueError:
                tl = 2000
            kind = m.group(1)
            if kind == "custom":
                r = run_py(code, raw, tl, c)
                return self.send_json({"status": r["status"], "ms": r["ms"], "code": r["code"],
                                       "out": cut(r["out"], 20000), "err": cut(r["err"], 2000)})
            pid = (q.get("id") or [""])[0]
            try:
                i = int((q.get("i") or ["-1"])[0])
            except ValueError:
                i = -1
            entry = tests_of(pid).get(pid)
            if not entry or i < 0 or i >= len(entry["tests"]):
                return self.send_json({"status": "SE", "ms": 0, "out": "", "code": -1,
                                       "err": "找不到 %s 的第 %d 组测试——检查本服务目录下有没有 "
                                              "data\\tests\\ch%s.json。" % (pid, i + 1, pid[2:4])})
            sin, exp = entry["tests"][i]
            r = run_py(code, sin, tl, c)
            ac = r["status"] == "OK" and same(r["out"], exp, entry.get("tol", ""))
            return self.send_json({"status": r["status"], "ac": ac, "ms": r["ms"], "code": r["code"],
                                   "out": cut(r["out"], 3000), "err": cut(r["err"], 2000),
                                   "exp": cut(exp if not ac else "", 3000),
                                   "inp": cut(sin, 3000) if not ac else ""})
        return self._send(404, "not found")


# --------------------------------------------------------------------------- #
def already_running(port, timeout=0.8):
    """该端口上是不是已经有一个本服务在跑。
    不能只 recv 一次——响应头和 body 可能分在两个 TCP 段里到达，只读一次很可能
    只拿到头，于是误判为「不是我们的服务」，进而去抢别的端口。"""
    import socket
    deadline = time.time() + timeout
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
            s.settimeout(timeout)
            s.sendall(b"GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            buf = b""
            tok = TOKEN.encode()
            while time.time() < deadline and len(buf) < 8192:
                try:
                    chunk = s.recv(1024)
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                if tok in buf:
                    return True
            return tok in buf
    except OSError:
        return False


def say(s=""):
    print(s, flush=True)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    os.makedirs(DATA, exist_ok=True)

    if not os.path.isdir(TDIR):
        say("=" * 58)
        say("   没找到 data\\tests 目录：自测运行可以用，「提交评测」不行。")
        say("   把判题包整个解压（不要只拖 server.py 出来）再运行本服务。")
        say("=" * 58)

    c = load_cfg()
    if not c["python"] or not os.path.exists(c["python"]):
        say("=" * 58)
        say("   这台电脑上没找到 Python 解释器。")
        say("   装一个 Python 3.10 以上（勾选 Add python.exe to PATH），")
        say("   或者在网页右上角「解释器设置」里填 python.exe 的完整路径。")
        say("=" * 58)
        return

    if already_running(PORT):
        say("=" * 58)
        say("   判题服务已经在运行（127.0.0.1:%d）" % PORT)
        say("")
        say("   >>>  浏览器打开：%s" % SITE)
        say("")
        say("   不用再起一个窗口，关掉这个窗口不影响已有的服务。")
        say("=" * 58)
        open_browser()
        return

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        say("=" * 58)
        say("   启动失败：端口 %d 被别的程序占用了（%s）" % (PORT, e))
        say("")
        say("   网站默认就连这个端口，请先关掉占用它的程序再运行本文件。")
        say("=" * 58)
        return

    n = 0
    try:
        n = len([f for f in os.listdir(TDIR) if f.endswith(".json")])
    except OSError:
        n = 0
    say("=" * 58)
    say("   Python 生活实验室 · 本地判题服务已启动")
    say("")
    say("   >>>  浏览器打开：%s" % SITE)
    say("")
    say("   解释器  ：%s" % c["python"])
    say("   附加参数：%s" % (c.get("flags") or "（无）"))
    say("   测试数据：%s（%d 个章文件）" % (TDIR if n else "缺失", n))
    say("   只监听 127.0.0.1，代码不出这台机器。")
    say("   关闭服务：关掉这个窗口，或按 Ctrl+C")
    say("=" * 58)
    open_browser()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        say("\n已关闭。")
    finally:
        httpd.server_close()
        with LOCK:
            for d in JOBS.values():
                shutil.rmtree(d, ignore_errors=True)
            JOBS.clear()


def open_browser():
    if "--no-browser" in sys.argv:
        return
    try:
        webbrowser.open(SITE)
    except Exception:
        pass


if __name__ == "__main__":
    main()
