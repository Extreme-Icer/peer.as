# peer-as-whois

WHOIS over HTTP — peer.as 前端的 WHOIS 兜底查询。

前端默认走 RDAP(浏览器直连各 RIR / 注册局,见 `ipcollect/web/src/lib/rdap.js`)。
部分 TLD / 注册局尚无 RDAP(典型如 `.de` 等 ccTLD),此时前端回退到本 worker:
worker 经 IANA root db 找到该 TLD 的 WHOIS server,走 TCP/43 查询,再以 HTTP 返回。

上游:<https://github.com/abersheeran/http-whois>(已归档)。本仓库基于其源码,做了以下改动:

1. **CORS** — 所有响应(含 `OPTIONS` 预检)加 `Access-Control-Allow-Origin: *`,
   否则浏览器直连无法读取。
2. **读到 EOF** — socket 读取改为循环读到 `done`,原版单次 `read()` 会截断跨多个
   TCP 段的响应(如 `.com` 的长法律声明)。
3. **whois server 提取** — IANA 页面该行现为 `<b>WHOIS Server:</b> whois.x.tld <br>`,
   原正则 `(.*)` 会把尾部 ` <br>` 吞进 hostname 导致 `connect` 报非法地址;改为只抓主机名。

## 部署

```
cd whois-worker
npm install
npm run deploy        # wrangler deploy
```

当前部署:<https://peer-as-whois.archeb.workers.dev>

## 用法

```bash
curl 'https://peer-as-whois.archeb.workers.dev/?domain=heise.de' -H 'Accept: application/json'
curl 'https://peer-as-whois.archeb.workers.dev/?domain=heise.de' -H 'Accept: text/plain'
```

JSON 形如 `{"server": "...", "domain": "...", "whois": "..."}`。浏览器直接打开 URL 为 HTML 页。
