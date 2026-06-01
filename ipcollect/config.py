"""配置: 焦点 ASN / 焦点地区 / 数据源。存为 JSON, 可手改也可用 `ipc config` 改。"""
from __future__ import annotations

import json
from typing import Any

from . import bgp, util

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

    # ASN 注册表: ASN -> 名称(展示/下拉用) + op(所属网络)。在此集中维护, 不在代码里 hard code。
    # 给 focus_asns / path_presets / 面板里出现的 ASN 起中文名; 也是 focus_asns 的"备注"来源。
    "asn_registry": [
        # 中国电信
        {"asn": 4809,  "name": "电信CN2",          "op": "电信"},
        {"asn": 23764, "name": "电信CTGNet",        "op": "电信"},
        {"asn": 4134,  "name": "电信163(ChinaNet)", "op": "电信"},
        {"asn": 4812,  "name": "上海电信",          "op": "电信"},
        {"asn": 4847,  "name": "北京电信",          "op": "电信"},
        # 中国联通
        {"asn": 9929,  "name": "联通CUII",  "op": "联通"},
        {"asn": 10099, "name": "联通(CUG)", "op": "联通"},
        {"asn": 4837,  "name": "联通169",   "op": "联通"},
        {"asn": 4808,  "name": "北京联通",  "op": "联通"},
        {"asn": 17621, "name": "上海联通",  "op": "联通"},
        {"asn": 17622, "name": "广州联通",  "op": "联通"},
        {"asn": 17816, "name": "广东联通",  "op": "联通"},
        # 中国移动
        {"asn": 58807, "name": "移动CMIN2", "op": "移动"},
        {"asn": 58453, "name": "移动CMI",   "op": "移动"},
        {"asn": 9808,  "name": "移动CMNET", "op": "移动"},
        {"asn": 24400, "name": "移动",       "op": "移动"},
        {"asn": 56040, "name": "广东移动",   "op": "移动"},
        {"asn": 56041, "name": "浙江移动",   "op": "移动"},
        # 中国教育和科研计算机网 CERNET
        {"asn": 4538,  "name": "教育网CERNET",        "op": "教育"},
        {"asn": 23910, "name": "教育网CERNET2(IPv6)", "op": "教育"},
        # 中国科技网 CSTNET
        {"asn": 7497,  "name": "科技网CSTNET", "op": "科技"},
        # 常见国际 transit
        {"asn": 1299,  "name": "Arelion(Telia)", "op": "国际"},
        {"asn": 2914,  "name": "NTT",      "op": "国际"},
        {"asn": 6453,  "name": "TATA",     "op": "国际"},
        {"asn": 3257,  "name": "GTT",      "op": "国际"},
        {"asn": 6762,  "name": "Sparkle",  "op": "国际"},
        {"asn": 12956, "name": "Telxius",  "op": "国际"},
        {"asn": 174,   "name": "Cogent",   "op": "国际"},
        {"asn": 3356,  "name": "Lumen",    "op": "国际"},
        {"asn": 6939,  "name": "HE",       "op": "国际"},
        {"asn": 3491,  "name": "PCCW",     "op": "国际"},
        {"asn": 1273,  "name": "Vodafone", "op": "国际"},
        {"asn": 701,   "name": "Verizon",  "op": "国际"},
        {"asn": 7018,  "name": "AT&T",     "op": "国际"},
        {"asn": 3320,  "name": "DTAG",     "op": "国际"},
    ],

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
    # 全球 ASN 名称表(APNIC): 给所有 AS 显示 asname(config.asn_registry 里特别标注的优先)。
    "autnums_url": "https://thyme.apnic.net/current/data-used-autnums",
    # 站点根 URL(SEO canonical/sitemap 用)
    "site_base": "https://peer.as",
}


def load() -> dict[str, Any]:
    if util.CONFIG_PATH.exists():
        cfg = json.loads(util.CONFIG_PATH.read_text(encoding="utf-8"))
        # 补齐新增默认键
        merged = dict(DEFAULT_CONFIG)
        merged.update(cfg)
    else:
        merged = dict(DEFAULT_CONFIG)
    bgp.set_registry(merged.get("asn_registry") or [])
    return merged


def save(cfg: dict[str, Any]) -> None:
    util.CONFIG_PATH.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def init_default(force: bool = False) -> bool:
    """写出默认配置。返回是否实际写入。"""
    if util.CONFIG_PATH.exists() and not force:
        return False
    save(DEFAULT_CONFIG)
    return True


# 模块导入即用默认注册表预填 bgp, 保证未 load() 时库函数也有名字可用; load() 会按 config.json 覆盖。
bgp.set_registry(DEFAULT_CONFIG["asn_registry"])
