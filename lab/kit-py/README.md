# Python 生活实验室 · 本地判题服务

把网站上的「提交评测」接到你自己机器上的 Python。三步：

1. **整个解压**这个包（别只把 `server.py` 拖出去——隐藏测试点在 `data\tests\` 里）。
2. 双击 `start.cmd`。窗口里会打印它找到的解释器和测试文件数，然后自动打开网站。
3. 回到浏览器，页面顶部那条黄色提示消失，就能提交了。

关窗口即停止服务。题目、讲解、参考思路不需要这个服务，网站直接就能读。

## 它是什么

单个 `server.py`，只用 Python 标准库，不需要 `pip install` 任何东西。
它在本机 `127.0.0.1:8642` 起一个很小的 HTTP 服务：页面把源码 POST 过来，它存成一个判题作业、
用 `py_compile` 查语法，然后按题号取第 i 组隐藏测试，喂给解释器跑，比对输出后把结果回给页面。

- 只监听 `127.0.0.1`：局域网里其他人连不上，也没有任何中转服务器。
- 你的答案不出这台机器；每次运行都在系统临时目录开一个新文件夹，跑完就删。
- 解释器路径和进度存在同目录的 `config.json`，删掉即重置。
- 测试数据：17 个章文件、334 题、4145 组输入输出，约 90 MB。

## 前置条件

- Python 3.10 以上（`start.cmd` 会依次试 `py -3`、`python`）。装的时候勾上 *Add python.exe to PATH*。
- Windows 之外也能跑，但超时后杀进程树、隐藏崩溃弹窗这些按 Windows 写。

## 判分口径

行尾空白和末尾空行不算差异，其余逐字符比对。第 8 章里那几道输出坐标的题额外做了归一：
「第 X 行第 Y 列」这种位置描述折成同一形式再比。没有内存限制，也没有沙箱——
它是练习器，不是比赛。别提交你不打算在自己机器上运行的代码。

每题的时限写在题面旁边（`tl`，毫秒）。超时判 TLE，非零退出判 RE 并附上 stderr。

## 常见问题

**黄色提示还在。** 服务没起来，或浏览器拦了本机请求。看 `start.cmd` 的窗口里有没有
「本地判题服务已启动」；有的话直接访问 http://127.0.0.1:8642/ping ，页面应显示 `pylab`。
显示了却网站仍连不上，换 Edge/Chrome/Firefox 打开网站，地址后面加 `?base=http://127.0.0.1:8642` 试试。

**提交后说「找不到 pl14-29 的第 3 组测试」。** `data\tests\` 没跟着解压过去，
或者章号文件缺失。整个压缩包重新解压一次。

**端口 8642 被占用。** 会直接报错退出。关掉占用它的程序；
或改 `server.py` 里的 `PORT = 8642`，然后在网站地址上加 `?base=http://127.0.0.1:<新端口>`。

**想同时开 C++ 和 Python 两个实验室。** 可以，两个服务端口不同（8710 与 8642），互不影响。

**「自测运行」和「提交评测」的区别。** 自测用你自己在页面上填的输入，跑完把 stdout 原样给你；
提交评测才用服务端的隐藏测试点并给出 AC/WA。

## 接口

给其它前端复用时的形状（全部 HTTP，请求体都是 UTF-8 文本）：

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/ping` | — | `pylab` |
| GET | `/api/config` | — | `{python, flags, detected[], dir}` |
| POST | `/api/config` | `解释器路径\n附加参数` | `{ok, python}` |
| GET | `/api/progress` | — | 任意 JSON |
| POST | `/api/progress` | 任意 JSON | `{ok}` |
| POST | `/api/selftest` | 一段 python | `{ok, out, ms, log, version}` |
| POST | `/api/compile` | 源代码 | `{ok, job, log}`，语法错时 `{ok:false, job, nopython, log}` |
| POST | `/api/case?id=pl14-29&i=2&job=&tl=2000` | 忽略（服务端用自己的测试） | `{status, ac, ms, code, out, err, exp, inp}` |
| POST | `/api/custom?job=&tl=2000` | 标准输入 | `{status, ms, code, out, err}` |
| GET | `/api/tests?ch=14` | — | `{ch, problems, tests}`，只报数量，不返回测试内容 |

响应带 `Access-Control-Allow-Origin: *` 和 `Access-Control-Allow-Private-Network: true`，
所以 https 页面能直接调用本机端口。
