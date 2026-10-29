# C++ 实验室 · 本地判题服务

把网站上的「提交」接到你自己机器上的 g++。三步：

1. 装好一个 MinGW-w64 的 g++（下面有推荐装法）。
2. 双击 `start.cmd`。窗口里会打印检测到的编译器路径，然后自动打开网站。
3. 回到浏览器，页面顶部那条黄色提示消失，就能提交了。

关窗口即停止服务。题目、讲义、参考解不需要这个服务，网站直接就能读。

## 它是什么

单个 `server.py`，只用 Python 标准库，不需要 `pip install` 任何东西。
它在本机 `127.0.0.1:8710` 起一个很小的 HTTP 服务，页面把源码 POST 过来，
它调用你指定的 g++ 编译、把标准输入喂给可执行文件、把输出和运行毫秒数回给页面。

- 只监听 `127.0.0.1`：局域网里其他人连不上，也没有任何中转服务器。
- 你的代码不出这台机器，编译产物写在系统临时目录 `%TEMP%\cpplab_judge`，关服务时删掉。
- 配置和进度存在同目录的 `data\`（`config.json`、`progress.json`），删掉即重置。

## 前置条件

- Windows。Linux/macOS 下 `python3 server.py` 也能起，但异常码解释和超时进程树清理按 Windows 写。
- Python 3.8+（`start.cmd` 会依次试 `py -3`、`python`）。
- 一个 g++ 或 clang++。

## 装编译器

最省事：MSYS2，装完在 UCRT64 终端里执行

```
pacman -S mingw-w64-ucrt-x86_64-gcc
```

编译器位于 `C:\msys64\ucrt64\bin\g++.exe`，本服务会自动扫到。
已经装过 Dev-C++ 或带 MinGW 的 Code::Blocks，通常也能直接自动扫到。

扫不到就在页面右上角「编译器设置」里手工填 `g++.exe` 的完整路径，
点「保存并测试」，页面会编译一个 a+b 小程序验证整条通路。

## 常见问题

**黄色提示还在。** 服务没起来，或浏览器拦了本机请求。看 `start.cmd` 的窗口里有没有
「本地判题服务已启动」；有的话直接访问 http://127.0.0.1:8710/ping ，页面应显示 `cpplab2`。
显示了却网站仍连不上，换 Edge/Chrome/Firefox 打开网站，
地址后面加 `?base=http://127.0.0.1:8710` 试试（`base` 也可以填别的端口）。

**端口 8710 被占用。** `start.cmd` 会直接报错退出。关掉占用它的程序，
或改 `server.py` 里的 `PORT = 8710`，然后在网站地址上加 `?base=http://127.0.0.1:<新端口>`。

**编译没报错却卡住 / 弹窗。** 服务已经关掉了 Windows 的崩溃对话框；
如果程序访问非法内存，结果里会写「访问了非法内存（空指针或数组越界）」而不是弹窗。

**判分口径。** 行尾空白和末尾空行不算差异，其余逐字符比对。没有内存限制，也没有沙箱——
它是练习器，不是比赛。别提交你不打算在自己机器上运行的代码。

## 接口

给其它前端复用时的形状（全部 HTTP，请求体都是 UTF-8 文本）：

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/ping` | — | `cpplab2` |
| GET | `/api/config` | — | `{compiler, flags, dir, detected[], os}` |
| POST | `/api/config` | `编译器路径\n编译选项` | `{ok}` |
| GET | `/api/progress` | — | 任意 JSON |
| POST | `/api/progress` | 任意 JSON | `{ok}` |
| POST | `/api/compile` | 源代码 | `{ok, ms, start, code, log}`，找不到编译器时 `{ok:false, nocompiler:true}` |
| POST | `/api/run?tl=1000` | 标准输入 | `{status, ms, wall, code, out, err}`，`status` ∈ OK/CE/RE/TLE/SE/NOEXE |

响应带 `Access-Control-Allow-Origin: *` 和 `Access-Control-Allow-Private-Network: true`，
所以 https 页面能直接调用本机端口。
