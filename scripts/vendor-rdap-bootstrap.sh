#!/usr/bin/env bash
# 下载 IANA RFC 9224 RDAP bootstrap 表(asn/ipv4/ipv6/dns), 精简合并成前端内置 JSON。
# 前端 rdap.js 据此把 ASN/IP/域名 直接映射到对应 RIR / TLD 注册局 的 RDAP base, 无需运行时依赖 rdap.org。
# 升级/刷新数据: 重跑本脚本(daily-refresh 亦可调用), 然后 npm build。
set -euo pipefail
OUT="$(cd "$(dirname "$0")/.." && pwd)/ipcollect/web/src/lib/rdap-bootstrap.json"
python3 - "$OUT" <<'PY'
import json, sys, urllib.request
out = sys.argv[1]
base = "https://data.iana.org/rdap/"
# dns.json 含全部 TLD 的 RDAP base(域名查询用); 其余三张是 ASN/IP。
res = {}
for kind, fn in (("asn","asn.json"), ("ipv4","ipv4.json"), ("ipv6","ipv6.json"), ("dns","dns.json")):
    with urllib.request.urlopen(base+fn, timeout=30) as r:
        d = json.load(r)
    # 只留 services(去掉 description/publication 等), 体积最小
    res[kind] = d.get("services", [])
res["_publication"] = "IANA RDAP bootstrap (RFC 9224)"
with open(out, "w") as f:
    json.dump(res, f, separators=(",",":"), ensure_ascii=False)
print("wrote", out, "asn:", len(res["asn"]), "ipv4:", len(res["ipv4"]),
      "ipv6:", len(res["ipv6"]), "dns:", len(res["dns"]))
PY
