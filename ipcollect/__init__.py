"""ipcollect — BGP 回程 AS_PATH 采集 / 分析 / 静态看板 (BGP Insights).

数据流:
    ingest (rrc00 MRT 全表)  ->  prefix / pathobs / path_asn  (按焦点 ASN 过滤)
    geo    (ipdb.txt)        ->  给 prefix 打 省/市/运营商 标签
    build                    ->  导出分片静态 JSON (dist/), 部署到 Cloudflare Pages
    query/insight/serve      ->  按 城市 + 回程(path 含 ASN/顺序) + origin 筛选与查路由
"""

__version__ = "1.0.0"
