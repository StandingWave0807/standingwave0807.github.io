#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
C++ 实验室 —— 本地判题服务（纯 Python 标准库，不装任何依赖）

只做一件事：把 https://phenolforever.com/lab/cpp.html 的判题请求接到你机器上的 g++。
页面本身还是从网站打开，这个服务不发送任何网页内容。

接口（与原实验室一致）：
    GET  /ping             -> "cpplab2"
    GET  /api/config       -> {compiler, flags, dir, detected[], os}
    POST /api/config       -> body "编译器路径\\n编译选项"
    GET  /api/progress     -> 进度/代码 JSON
    POST /api/progress     -> 保存进度/代码 JSON
    POST /api/compile      -> body = 源代码; 回 {ok, ms, start, code, log}
    POST /api/run?tl=1000  -> body = 标准输入; 回 {status, ms, wall, code, out, err}
    GET  /api/quit         -> "bye" 并退出

只监听 127.0.0.1：局域网里的其他人连不上，也不会经过任何服务器。
"""
import json
import os
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
DATA_DIR = os.path.join(ROOT, "data")
WORK_DIR = os.path.join(tempfile.gettempdir(), "cpplab_judge")

SITE = "https://phenolforever.com/lab/cpp.html"
PORT = 8710

DEFAULT_FLAGS = "-std=c++17 -O2"
COMPILE_TIMEOUT = 60.0
OUTPUT_LIMIT = 512 * 1024

# ---------------------------------------------------------------- 抑制崩溃弹窗
# 学生代码一旦访问非法内存，Windows 会弹出模态「应用程序错误」对话框，进程被挂住
# → 判题只能等到超时，误报成 TLE，弹窗还会一直糊在屏幕上。
# SEM_NOGPFAULTERRORBOX 让系统不再显示这个框；错误模式被子进程继承，
# 所以在服务进程里设一次就够了。
SEM_FAILCRITICALERRORS = 0x0001
SEM_NOGPFAULTERRORBOX = 0x0002
SEM_NOOPENFILEERRORBOX = 0x8000
CREATE_NO_WINDOW = 0x08000000

_IS_WIN = (os.name == "nt")


def suppress_crash_dialogs():
    if not _IS_WIN:
        return
    try:
        import ctypes
        ctypes.windll.kernel32.SetErrorMode(
            SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX)
    except Exception:
        pass


suppress_crash_dialogs()
CREATIONFLAGS = CREATE_NO_WINDOW if _IS_WIN else 0

EXC_NAMES = {
    0xC0000005: "访问了非法内存（空指针或数组越界）",
    0xC000001D: "执行了非法指令（多半是未定义行为，如除零或越界）",
    0xC00000FD: "栈溢出（多半是递归没有出口，或局部数组开得太大）",
    0xC0000094: "整数除以 0",
    0xC0000095: "整数溢出",
    0xC0000374: "堆被破坏（多半是越界写或重复释放）",
    0xC0000409: "检测到栈缓冲区溢出（局部数组被写越界）",
    0xC000013A: "程序被强制终止",
    0xC0000142: "程序初始化失败（缺少运行库 DLL）",
}


def explain_exit(code):
    u = code & 0xFFFFFFFF
    if u in EXC_NAMES:
        return EXC_NAMES[u]
    if u >= 0xC0000000:
        return "程序异常终止（0x%08X）" % u
    return None


CANDIDATES = [
    r"C:\msys64\ucrt64\bin\g++.exe",
    r"C:\msys64\mingw64\bin\g++.exe",
    r"C:\msys64\clang64\bin\clang++.exe",
    r"C:\mingw64\bin\g++.exe",
    r"C:\MinGW\bin\g++.exe",
    r"C:\TDM-GCC-64\bin\g++.exe",
    r"C:\winlibs\mingw64\bin\g++.exe",
    r"C:\Program Files\CodeBlocks\MinGW\bin\g++.exe",
    r"C:\Program Files (x86)\CodeBlocks\MinGW\bin\g++.exe",
    r"C:\Program Files (x86)\Dev-Cpp\MinGW64\bin\g++.exe",
    r"C:\Program Files (x86)\Embarcadero\Dev-Cpp\TDM-GCC-64\bin\g++.exe",
    r"C:\Program Files\Embarcadero\Dev-Cpp\TDM-GCC-64\bin\g++.exe",
    r"C:\Dev-Cpp\MinGW64\bin\g++.exe",
    r"C:\Program Files\LLVM\bin\clang++.exe",
    r"D:\msys64\ucrt64\bin\g++.exe",
    r"D:\msys64\mingw64\bin\g++.exe",
    r"D:\mingw64\bin\g++.exe",
    r"D:\MinGW\bin\g++.exe",
    r"D:\TDM-GCC-64\bin\g++.exe",
    r"D:\winlibs\mingw64\bin\g++.exe",
    r"D:\Dev-Cpp\MinGW64\bin\g++.exe",
    r"E:\msys64\ucrt64\bin\g++.exe",
    r"E:\mingw64\bin\g++.exe",
]


# --------------------------------------------------------------------------- #
# 配置与进度
# --------------------------------------------------------------------------- #
def cfg_path():
    return os.path.join(DATA_DIR, "config.json")


def progress_path():
    return os.path.join(DATA_DIR, "progress.json")


def detect_compilers():
    found = []
    for p in CANDIDATES:
        if os.path.isfile(p):
            found.append(p)
    for name in ("g++.exe", "g++", "clang++.exe", "clang++"):
        w = shutil.which(name)
        if w and w not in found:
            found.append(w)
    return found


def load_config():
    cfg = {"compiler": "", "flags": DEFAULT_FLAGS}
    try:
        with open(cfg_path(), encoding="utf-8") as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    if not cfg.get("flags"):
        cfg["flags"] = DEFAULT_FLAGS
    if not cfg.get("compiler"):
        det = detect_compilers()
        if det:
            cfg["compiler"] = det[0]
    return cfg


def save_config(cfg):
    try:
        with open(cfg_path(), "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


def load_progress():
    for p in (progress_path(), progress_path() + ".bak"):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            continue
    return {}


def save_progress(obj):
    p = progress_path()
    try:
        if os.path.exists(p):
            shutil.copyfile(p, p + ".bak")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# 编译 / 运行
# --------------------------------------------------------------------------- #
def decode(b):
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            return b.decode(enc)
        except Exception:
            continue
    return b.decode("utf-8", "replace")


def compile_source(code):
    cfg = load_config()
    cc = cfg.get("compiler") or ""
    if not cc or not os.path.isfile(cc):
        return {"ok": False, "nocompiler": True, "log": ""}

    os.makedirs(WORK_DIR, exist_ok=True)
    src = os.path.join(WORK_DIR, "main.cpp")
    exe = os.path.join(WORK_DIR, "prog.exe")
    with open(src, "w", encoding="utf-8", newline="\n") as f:
        f.write(code)
    if os.path.exists(exe):
        try:
            os.remove(exe)
        except Exception:
            pass

    flags = (cfg.get("flags") or DEFAULT_FLAGS).split()
    cmd = [cc] + flags + ["-fdiagnostics-color=never", "main.cpp", "-o", "prog.exe"]
    t0 = time.perf_counter()
    start = True
    try:
        pr = subprocess.run(
            cmd, cwd=WORK_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=COMPILE_TIMEOUT, creationflags=CREATIONFLAGS)
        out = decode(pr.stdout or b"")
        rc = pr.returncode
        ok = (rc == 0) and os.path.exists(exe)
    except subprocess.TimeoutExpired:
        out = "编译超时（超过 %.0f 秒），请检查代码。" % COMPILE_TIMEOUT
        rc, ok = 1, False
    except OSError as e:
        out = "编译器无法启动：%s" % e
        rc, ok, start = 1, False, False
    ms = (time.perf_counter() - t0) * 1000.0
    return {"ok": ok, "ms": round(ms, 1), "start": start, "code": rc, "log": out}


def run_program(stdin_text, tl_ms):
    exe = os.path.join(WORK_DIR, "prog.exe")
    if not os.path.exists(exe):
        return {"status": "NOEXE"}
    if stdin_text and not stdin_text.endswith("\n"):
        stdin_text += "\n"

    in_f = os.path.join(WORK_DIR, "input.txt")
    out_f = os.path.join(WORK_DIR, "output.txt")
    err_f = os.path.join(WORK_DIR, "stderr.txt")
    with open(in_f, "w", encoding="utf-8", newline="\n") as f:
        f.write(stdin_text or "")

    t0 = time.perf_counter()
    status, code, exc_hint = "OK", 0, None
    try:
        with open(in_f, "rb") as fi, open(out_f, "wb") as fo, open(err_f, "wb") as fe:
            proc = subprocess.Popen([exe], stdin=fi, stdout=fo, stderr=fe,
                                    creationflags=CREATIONFLAGS)
            try:
                code = proc.wait(timeout=max(0.05, tl_ms / 1000.0))
            except subprocess.TimeoutExpired:
                status = "TLE"
                try:
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   timeout=10, creationflags=CREATIONFLAGS)
                except Exception:
                    pass
                try:
                    proc.kill()
                except Exception:
                    pass
                try:
                    proc.wait(timeout=5)
                except Exception:
                    pass
                code = 0
    except OSError as e:
        return {"status": "SE", "ms": 0.0, "wall": 0.0, "code": 0,
                "out": "", "err": "无法启动程序：%s" % e}
    wall = (time.perf_counter() - t0) * 1000.0

    def rd(p):
        try:
            with open(p, "rb") as f:
                return f.read(OUTPUT_LIMIT)
        except Exception:
            return b""

    out = decode(rd(out_f))
    err = decode(rd(err_f))
    if status == "OK" and code != 0:
        status = "RE"
        exc_hint = explain_exit(code)
    out = out.replace("\r\n", "\n").replace("\r", "\n")
    err = err.replace("\r\n", "\n").replace("\r", "\n")
    if exc_hint:
        err = (exc_hint + "\n" + err).strip()
    return {"status": status, "ms": round(wall, 1), "wall": round(wall, 1),
            "code": code, "out": out, "err": err[:8000]}


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
LANDING = """<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8">
<title>C++ 实验室 · 本地判题服务</title>
<body style="font:16px/1.8 system-ui;margin:48px;max-width:40em">
<h2>判题服务已经在跑</h2>
<p>这个服务不提供网页，只执行编译。题目在网站上：
<a href="%s">%s</a></p>
<p>关掉本服务的窗口即可停止。</p>
</body></html>""" % (SITE, SITE)


class Handler(BaseHTTPRequestHandler):
    server_version = "CppLabJudge/2.0"
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

    def do_OPTIONS(self):
        self._read_body()
        self.send_response(204)
        self.send_header("Allow", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         self.headers.get("Access-Control-Request-Headers") or "*")
        self.send_header("Access-Control-Max-Age", "86400")
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        return self.rfile.read(n) if n > 0 else b""

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path.rstrip("/") or "/"
        if p == "/ping":
            return self._send(200, "cpplab2")
        if p == "/api/config":
            cfg = load_config()
            return self._send(200, json.dumps({
                "compiler": cfg.get("compiler", ""),
                "flags": cfg.get("flags", DEFAULT_FLAGS),
                "dir": DATA_DIR,
                "detected": detect_compilers(),
                "os": "windows" if _IS_WIN else "other",
            }, ensure_ascii=False), "application/json; charset=utf-8")
        if p == "/api/progress":
            return self._send(200, json.dumps(load_progress(), ensure_ascii=False),
                              "application/json; charset=utf-8")
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
        body = self._read_body()
        if p == "/api/config":
            try:
                lines = decode(body).split("\n")
                cc = (lines[0] if lines else "").strip().strip('"')
                fl = (lines[1] if len(lines) > 1 else "").strip()
                cfg = load_config()
                if cc:
                    cfg["compiler"] = cc
                cfg["flags"] = fl or DEFAULT_FLAGS
                save_config(cfg)
                return self._send(200, json.dumps({"ok": True}),
                                  "application/json; charset=utf-8")
            except Exception as e:
                return self._send(400, json.dumps({"ok": False, "log": str(e)}),
                                  "application/json; charset=utf-8")
        if p == "/api/progress":
            try:
                save_progress(json.loads(decode(body)))
            except Exception:
                pass
            return self._send(200, json.dumps({"ok": True}),
                              "application/json; charset=utf-8")
        if p == "/api/compile":
            return self._send(200, json.dumps(compile_source(decode(body)),
                              ensure_ascii=False), "application/json; charset=utf-8")
        if p == "/api/run":
            q = parse_qs(u.query)
            try:
                tl = float((q.get("tl") or ["1000"])[0])
            except ValueError:
                tl = 1000.0
            tl = min(max(tl, 50.0), 60000.0)
            return self._send(200, json.dumps(run_program(decode(body), tl),
                              ensure_ascii=False), "application/json; charset=utf-8")
        return self._send(404, "not found")


# --------------------------------------------------------------------------- #
def already_running(port, timeout=0.8):
    """8710 上是不是已经有一个本服务在跑。
    不能只 recv 一次——响应头和 body 可能分在两个 TCP 段里到达，
    只读一次很可能只拿到头，于是误判为「不是我们的服务」。"""
    import socket
    deadline = time.time() + timeout
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
            s.settimeout(timeout)
            s.sendall(b"GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            buf = b""
            while time.time() < deadline and len(buf) < 8192:
                try:
                    chunk = s.recv(1024)
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                if b"cpplab2" in buf:
                    return True
            return b"cpplab2" in buf
    except OSError:
        return False


def say(s=""):
    print(s, flush=True)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    os.makedirs(DATA_DIR, exist_ok=True)

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
        say("   实在改不了端口就别用本机判题，页面上的「在线判题」不需要本机服务。")
        say("=" * 58)
        time.sleep(600)
        return

    cfg = load_config()
    say("=" * 58)
    say("   C++ 实验室 · 本地判题服务已启动")
    say("")
    say("   >>>  浏览器打开：%s" % SITE)
    say("")
    say("   编译器  ：%s" % (cfg.get("compiler") or "（没找到 g++，请在页面右上角「编译器设置」里选）"))
    say("   编译选项：%s" % cfg.get("flags"))
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
        shutil.rmtree(WORK_DIR, ignore_errors=True)


def open_browser():
    if "--no-browser" in sys.argv:
        return
    try:
        webbrowser.open(SITE)
    except Exception:
        pass


if __name__ == "__main__":
    main()
