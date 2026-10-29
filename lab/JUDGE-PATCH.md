# 让网站能连上本机评测台

网站在 `https://phenolforever.com/lab/`，评测台在 `http://127.0.0.1:8832`。
从 https 页面请求本机端口，Chrome 会先发一个私有网络预检（Private Network Access），
要求服务端回一个专门的头，否则请求直接 `net::ERR_FAILED`——不是超时，是根本没发出去。

## 要改的地方

文件：`Desktop\0011\两题评测台\server.py`，第 104–109 行那个统一发头的地方。

现在长这样：

```python
self.send_header("Access-Control-Allow-Origin", "*")
self.send_header("Access-Control-Allow-Headers", "Content-Type")
self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
```

改成：

```python
origin = self.headers.get("Origin") or "*"
self.send_header("Access-Control-Allow-Origin", origin)
self.send_header("Access-Control-Allow-Headers", "Content-Type")
self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
if self.headers.get("Access-Control-Request-Private-Network"):
    self.send_header("Access-Control-Allow-Private-Network", "true")
```

两处改动，理由：

1. **`*` 换成回显 Origin**。`Access-Control-Allow-Private-Network: true` 和 `*` 同时出现时，
   Chrome 会拒绝这个预检——通配符和私有网络放行不能共存。
2. **补 `Access-Control-Allow-Private-Network: true`**。只在预检带
   `Access-Control-Request-Private-Network` 时回，别无条件发。

## 判据

改完重启 bat，然后在 `https://phenolforever.com/lab/` 页面上看状态灯：

- 变绿（`评测台 已连接 · g++ …`）→ 通了。
- 还是灰的 → 打开 DevTools Network 看 `http://127.0.0.1:8832/ping`：
  - `ERR_FAILED` + 有一行 CORS 相关红字 → 上面的改动没生效，检查是不是改在了别的分支上。
  - `net::ERR_CONNECTION_REFUSED` → 服务根本没起，跟网站无关。
  - 请求 200 但页面仍显示未连接 → 是页面探测逻辑的问题，把响应体贴给我。

## 本地开发时不用改

如果你直接用 `http://127.0.0.1:xxxx/` 起网站（同源或同为 http 的本机地址），
不触发混合内容与私有网络预检，不改也能连。这个补丁只在从 https 页面连本机时才需要。

## 另外两点，跟改动无关但你该知道

- `server.py` 只有时间限制，**没有内存限制也没有沙箱**（没有 rlimit / job object）。
  提交死循环分配内存的代码会把机器拖住。自用可以，别拿去公开服务。
- 判分在前端 `norm()` 做全文比对，服务端只回 stdout。所以换台机器、换个浏览器，
  判定口径一致；但任何"改了前端就能改判分"的顾虑是成立的——这是自用练习器，不是比赛。
