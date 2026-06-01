"""SSG: 为爬虫预渲染**双语(中/英)静态落地页** + sitemap + robots。

WASM 查询型站点(app.js 在浏览器里发 SQL)对搜索引擎几乎不可见 —— 爬虫拿不到内容。
故 build 时为每个国家生成一张**含真实内容**的静态 HTML(国家名中英、前缀数、主要 origin 网络、
焦点城市), 带规范的 <title>/<meta description>/OG/canonical, 并链接进交互看板(`/?cc=XX`)。
另出 countries.html(国家索引)、sitemap.xml、robots.txt。这是"初步 i18n + 对应 SEO"。
"""
from __future__ import annotations

import html
import time
from pathlib import Path
from urllib.parse import quote

from . import bgp, util

DEFAULT_SITE = "https://peer.as"


def _esc(s) -> str:
    return html.escape(str(s if s is not None else ""))


def _head(title, desc, canonical, lang="zh") -> str:
    return f"""<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>{_esc(title)}</title>
<meta name="description" content="{_esc(desc)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="{_esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="{_esc(title)}">
<meta property="og:description" content="{_esc(desc)}">
<meta property="og:url" content="{_esc(canonical)}">
<meta name="twitter:card" content="summary">
<style>.ssg{{max-width:920px;margin:0 auto;padding:24px 18px;line-height:1.6;
font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
background:#0a0e15;color:#dde6f0;min-height:100vh}}
body{{margin:0}}
.ssg h1{{font-size:1.5rem;margin:.2em 0}}.ssg .sub{{opacity:.7;margin:0 0 1em}}
.ssg .cta{{display:inline-block;margin:14px 0;padding:8px 16px;border-radius:8px;
background:#2563eb;color:#fff;text-decoration:none;font-weight:600}}
.ssg ul{{padding-left:1.2em}}.ssg .muted{{opacity:.65;font-size:.9em}}
.ssg a{{color:#2563eb}}</style>
</head>
<body><main class="ssg">"""


def _origins(con, cc: str, asnames: dict) -> list[tuple]:
    rows = con.execute(
        "SELECT origin_asn, count(*) c FROM s.prefix "
        "WHERE country_code=? AND family=4 AND origin_asn IS NOT NULL "
        "GROUP BY 1 ORDER BY c DESC LIMIT 8", [cc]).fetchall()
    return [(r[0], r[1], asnames.get(r[0]) or "") for r in rows]  # asnames: int -> name


def _country_page(cc, meta, con, asnames) -> str:
    zh = meta.get("country_names", {}).get(cc) or cc
    en = meta.get("country_names_en", {}).get(cc) or cc
    site = meta.get("site_base") or DEFAULT_SITE
    canonical = f"{site}/c/{cc}.html"
    n_prefix = next((c["n_prefix"] for c in meta.get("countries", []) if c["cc"] == cc), 0)
    origins = _origins(con, cc, asnames)
    cities = (meta.get("cities", {}) or {}).get(cc) or []

    title = f"{zh} / {en} ({cc}) — BGP 路由 · ASN · IP 前缀 · PEER.AS"
    desc = (f"{zh}({cc}) 的 BGP 路由洞察：{n_prefix} 个 IPv4 前缀、主要 origin ASN/网络、AS_PATH 与城市分布。"
            f" BGP routing, ASN & IP prefix insights for {en} ({cc}): {n_prefix} IPv4 prefixes, "
            f"top origin networks, AS_PATH and city breakdown.")
    h = _head(title, desc, canonical)
    h += f'<nav class="muted"><a href="/">← PEER.AS</a> · <a href="/countries.html">所有国家 / All countries</a></nav>'
    h += f"<h1>{_esc(zh)} <span class=muted>/ {_esc(en)} ({_esc(cc)})</span></h1>"
    h += (f'<p class="sub">{zh} 在全球 BGP 路由表里的 <b>{n_prefix}</b> 个 IPv4 前缀：origin ASN、AS_PATH、城市分布。'
          f'<br><b>{n_prefix}</b> IPv4 prefixes for {_esc(en)} — origin ASNs, AS_PATH and routing.</p>')
    h += f'<a class="cta" href="/?cc={_esc(cc)}">在交互看板查看 / Open in dashboard →</a>'
    if origins:
        h += "<h2>主要 origin 网络 / Top origin networks</h2><ul>"
        for a, c, nm in origins:
            h += f"<li>AS{a}{(' · ' + _esc(nm)) if nm else ''} <span class=muted>— {c} 前缀 / prefixes</span></li>"
        h += "</ul>"
    if cities:
        h += "<h2>主要城市 / Top cities</h2><ul>"
        for ci in cities[:15]:
            # href 里的 city 要 URL 编码(中文/特殊字符); 显示文本用 HTML 转义。
            h += (f'<li><a href="/?cc={quote(cc)}&city={quote(ci["name"])}">{_esc(ci["name"])}</a> '
                  f'<span class=muted>— {ci["n_prefix"]} 前缀 / prefixes</span></li>')
        h += "</ul>"
    h += ('<p class="muted">数据来源：RIPE RIS rrc00 公开 MRT 全表的回程 AS_PATH（仅供学习研究 BGP）。'
          ' Data: RIPE RIS rrc00 public MRT full table. For BGP research/education only.</p>')
    h += f'<p class="muted">生成 / generated: {_esc(meta.get("generated_str",""))}</p>'
    return h + "</main></body></html>\n"


def _countries_index(meta) -> str:
    site = meta.get("site_base") or DEFAULT_SITE
    title = "所有国家与地区 / All countries — PEER.AS"
    desc = "按国家/地区浏览全球 BGP 回程路由 AS_PATH。Browse global BGP backhaul AS_PATH by country/region."
    h = _head(title, desc, f"{site}/countries.html")
    h += '<nav class="muted"><a href="/">← PEER.AS</a></nav>'
    h += "<h1>所有国家与地区 / All countries &amp; regions</h1><ul>"
    for c in meta.get("countries", []):
        cc = c["cc"]
        zh = meta.get("country_names", {}).get(cc) or cc
        en = meta.get("country_names_en", {}).get(cc) or cc
        h += (f'<li><a href="/c/{_esc(cc)}.html">{_esc(zh)} / {_esc(en)} ({_esc(cc)})</a> '
              f'<span class=muted>— {c["n_prefix"]} 前缀 / prefixes</span></li>')
    return h + "</ul></main></body></html>\n"


def generate(out: Path, meta: dict, con, asnames=None) -> int:
    asnames = asnames or {}
    out = Path(out)
    site = (meta.get("site_base") or DEFAULT_SITE).rstrip("/")
    cdir = out / "c"
    cdir.mkdir(parents=True, exist_ok=True)
    ccs = [c["cc"] for c in meta.get("countries", []) if c["cc"] and c["cc"] != "ZZ"]
    for cc in ccs:
        (cdir / f"{cc}.html").write_text(_country_page(cc, meta, con, asnames), encoding="utf-8")
    (out / "countries.html").write_text(_countries_index(meta), encoding="utf-8")

    # sitemap.xml
    urls = [f"{site}/", f"{site}/countries.html"] + [f"{site}/c/{cc}.html" for cc in ccs]
    lastmod = time.strftime("%Y-%m-%d", time.localtime(meta.get("generated_ts") or time.time()))
    sm = ['<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        sm.append(f"<url><loc>{_esc(u)}</loc><lastmod>{lastmod}</lastmod></url>")
    sm.append("</urlset>")
    (out / "sitemap.xml").write_text("\n".join(sm), encoding="utf-8")
    (out / "robots.txt").write_text(
        f"User-agent: *\nAllow: /\nSitemap: {site}/sitemap.xml\n", encoding="utf-8")
    util.log(f"  SSG: {len(ccs)} 国家页 + countries.html + sitemap.xml + robots.txt")
    return len(ccs) + 1
