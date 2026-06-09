"""配置: 焦点 ASN / 焦点地区 / 数据源。存为 JSON, 可手改也可用 `ipc config` 改。"""
from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from . import bgp, util

# ASN 注册表数据文件 (随包分发, 可直接 PR 补充)。见文件头注释说明列含义。
ASN_REGISTRY_CSV = Path(__file__).resolve().parent / "data" / "asn_registry.csv"


def _load_asn_registry_csv() -> list[dict[str, Any]]:
    """读 data/asn_registry.csv -> [{asn, name, name_en?, op}]。
    '#' 开头的行为注释 (在送入 csv 前剔除); name_en 留空则不输出该键。"""
    if not ASN_REGISTRY_CSV.exists():
        return []
    lines = [ln for ln in ASN_REGISTRY_CSV.read_text(encoding="utf-8").splitlines()
             if ln.strip() and not ln.lstrip().startswith("#")]
    out: list[dict[str, Any]] = []
    for row in csv.DictReader(lines):
        asn = (row.get("asn") or "").strip()
        if not asn.isdigit():
            continue
        e: dict[str, Any] = {"asn": int(asn), "name": (row.get("name") or "").strip(),
                             "op": (row.get("op") or "").strip()}
        name_en = (row.get("name_en") or "").strip()
        if name_en:
            e["name_en"] = name_en
        out.append(e)
    return out

DEFAULT_CONFIG: dict[str, Any] = {
    # ingest 入库口径 = (AS_PATH 含 focus_asns 任一) ∩ (地理落在 focus_cities/provinces)。
    # focus_asns 纯粹是 "path 上出现过这些 ASN" 的过滤器, 无任何质量含义。
    "focus_asns": [
        4809, 23764, 4134,        # 电信 CN2 / CTGNet / 163
        9929, 10099, 4837,        # 联通 CUII / CUG / 169
        58807, 58453, 9808,       # 移动 CMIN2 / CMI / CMNET
        4538, 7497,               # 教育 CERNET / 科技 CSTNET
    ],
    # 展示用的关注城市 (按 ipdb 的 city 字段精确匹配)。**不影响入库**(入库是境内全量含焦点ASN);
    # 仅决定面板把前缀切到哪些城市来展示。覆盖一线+新一线+二线+省会, 基本覆盖全国二线及以上。
    "focus_cities": [
        # 一线
        "北京", "上海", "广州", "深圳",
        # 新一线
        "成都", "重庆", "杭州", "武汉", "西安", "郑州", "青岛", "长沙", "天津",
        "苏州", "南京", "东莞", "沈阳", "合肥", "宁波", "昆明",
        # 二线
        "无锡", "佛山", "大连", "福州", "厦门", "哈尔滨", "济南", "温州", "南宁",
        "长春", "泉州", "石家庄", "贵阳", "南昌", "金华", "常州", "南通", "嘉兴",
        "太原", "徐州", "惠州", "珠海", "中山", "台州", "烟台", "兰州", "绍兴",
        "海口", "扬州", "汕头", "洛阳", "潍坊", "保定", "廊坊",
        # 其余省会/首府 (全国覆盖)
        "乌鲁木齐", "银川", "呼和浩特", "西宁", "拉萨",
    ],
    "focus_provinces": [],            # 备选: 按省匹配, 如 ["上海", "广东"]
    "focus_country_code": "CN",       # 只保留该国家的前缀 (空=不限)

    # path 搜索预制下拉项 (命名的 path 连续片段; 用户也可在面板/CLI 自行输入)。
    # alias = 给一段 path 起的别名; path = 要求按此顺序相邻出现的 ASN 序列。
    "path_presets": [
        {"alias": "电信CN2", "path": [4809]},
        {"alias": "电信CTGNet", "path": [23764, 4809]},
        {"alias": "联通CUII", "path": [9929]},
        {"alias": "移动CMIN2", "path": [58807]},
        {"alias": "移动CMI", "path": [58453]},
        {"alias": "教育网CERNET", "path": [4538]},
        {"alias": "科技网CSTNET", "path": [7497]},
        {"alias": "教育网→科技网", "path": [4538, 7497]},
    ],

    # ASN 注册表: ASN -> 名称(展示/下拉用) + op(运营商/厂商分类) [+ name_en 可选]。
    # 数据集中维护在 data/asn_registry.csv (可直接 PR), 不在代码里 hard code。
    # config.json 里若有 asn_registry 会整体覆盖此默认表。
    "asn_registry": _load_asn_registry_csv(),

    # 入库范围:
    #   "global" = 全球全表(收全部 v4 前缀, 不按 ASN/国家过滤; focus_* 仅作高亮/导航)。
    #   "focus"  = 旧口径(境内 ∩ AS_PATH 含 focus_asns)。
    "ingest_scope": "global",

    # 数据源
    "ipdb_path": str(util.DEFAULT_IPDB),
    # geo 三轨(按优先级合并为非重叠区间, 见 geoip.build_geo_index):
    #   ipdb   私有库(国内城市级, 官方部署, 最优先)
    #   geolite GeoLite2-City(全球城市级, 含 v4+v6; 补国际与 v6)
    #   rir    RIR 国家级开放库(OSS 可复现兜底)
    # geo_provider: 主来源(ipdb / rir); GeoLite 始终叠加(若可下载), 在 ipdb 之后、rir 之前。
    "geo_provider": "ipdb",
    # GeoLite2 mmdb 来源(P3TERX 镜像, 按日期 tag 发布)。ingest 每次检查最新 release 是否比本地新, 过期才下。
    "geolite_repo": "P3TERX/GeoLite.mmdb",
    "geolite_city_asset": "GeoLite2-City.mmdb",
    "geolite_asn_asset": "GeoLite2-ASN.mmdb",
    # 采集点(RIPE RIS): 双点互补 —— rrc01(LINX, 伦敦) + rrc06(NSPIXP, 东京)。弃用 rrc00(代表性不足)。
    # 兼容: 若缺 mrt_collectors 则回退单值 mrt_collector。
    "mrt_collectors": ["rrc01", "rrc06"],
    "mrt_collector": "rrc01",
    "mrt_base_url": "https://data.ris.ripe.net",
    # MRT 源布局: "ripe"=列月份目录取最新 bview.*.gz(RIPE RIS); "dn42"=直接取 master4/6_latest.mrt.bz2(dn42 GRC)。
    # dn42 站(site=dn42)的 config.json 设 mrt_layout="dn42" + mrt_base_url="https://mrt42.strexp.net"。
    "mrt_layout": "ripe",
    # dn42 registry(全量 whois)git 仓库; 仅 dn42 站用(ASN 名/person/whois/ROA 来源)。空=不启用。
    "registry_repo": "",
    # 全球 ASN 名称表(APNIC): 给所有 AS 显示 asname(config.asn_registry 里特别标注的优先)。
    "autnums_url": "https://thyme.apnic.net/current/data-used-autnums",
    # 站点根 URL(SEO canonical/sitemap 用)
    "site_base": "https://peer.as",

    # 站点 profile: 选定一套特性开关(见 profile.py)。"peeras"=全球公网(现状全开); "dn42"=dn42 fork(无 geo)。
    # 单个开关可用 "features": {"geo": false, ...} 逐项覆盖(无需换 site)。**默认 peeras = 当前行为, 勿改**。
    "site": "peeras",
    # CF Pages 项目名(deploy.sh 用)。peeras=bgp-insights; dn42 实例在自己的 config.json 设(如 dn42-peer-as)。
    "cf_project": "bgp-insights",
}


def load() -> dict[str, Any]:
    raw: dict[str, Any] = {}
    if util.CONFIG_PATH.exists():
        raw = json.loads(util.CONFIG_PATH.read_text(encoding="utf-8"))
    merged = dict(DEFAULT_CONFIG)   # 补齐新增默认键
    merged.update(raw)
    # asn_registry: peeras 站始终以 data/asn_registry.csv 为权威源(改 CSV 即时生效, 覆盖任何被
    # 旧 init 冻结进 config.json 的表)。dn42 站走 registry.py、保持其 config 的空表, 不灌 CSV。
    if merged.get("site", "peeras") != "dn42":
        merged["asn_registry"] = _load_asn_registry_csv()
    bgp.set_registry(merged.get("asn_registry") or [])
    return merged


def save(cfg: dict[str, Any]) -> None:
    # 不把 asn_registry 持久化进 config.json(保持精简 + 不冻结 CSV); 维护走 data/asn_registry.csv。
    out = {k: v for k, v in cfg.items() if k != "asn_registry"}
    util.CONFIG_PATH.write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def init_default(force: bool = False) -> bool:
    """写出默认配置。返回是否实际写入。"""
    if util.CONFIG_PATH.exists() and not force:
        return False
    save(DEFAULT_CONFIG)
    return True


# 模块导入即用默认注册表预填 bgp, 保证未 load() 时库函数也有名字可用; load() 会按 config.json 覆盖。
bgp.set_registry(DEFAULT_CONFIG["asn_registry"])
