"""AS_PATH 清洗、ASN 命名、path 片段匹配、multihome 等价路由聚合。

设计取向：BGP 数据里有参考价值的只有 **AS_PATH**——path 里有哪些 ASN + 这些 ASN 的顺序。
不做任何"线路质量"评分（CN2 vs GIA 之类从境外 collector 的回程 BGP 根本分不出）。
ASN 仅保留"名称"用于展示与下拉。
"""
from __future__ import annotations

from typing import Iterable

# ----------------------------------------------------------------------------
# ASN -> {name, op} 注册表 (仅展示/下拉用; 不含任何质量含义)。op 为所属网络。
# 数据**不在此 hard code**, 而是来自 config.json 的 `asn_registry`, 由 config.set_registry()
# 在加载配置时灌入 (config 模块导入即用 DEFAULT_CONFIG 预填一份, 保证库函数随时可用)。
# 这两个 dict 对象身份保持不变, 重载时原地 clear+填充, 不影响 `from . import bgp` 的引用。
# ----------------------------------------------------------------------------
ASN_REGISTRY: dict[int, dict] = {}
ASN_NAME: dict[int, str] = {}


def set_registry(entries: Iterable[dict]) -> None:
    """从配置 (list of {asn, name, op}) 原地重载 ASN 注册表。"""
    ASN_REGISTRY.clear()
    ASN_NAME.clear()
    for e in entries or []:
        try:
            asn = int(e["asn"])
        except (KeyError, TypeError, ValueError):
            continue
        name = str(e.get("name") or "")
        ASN_REGISTRY[asn] = {"name": name, "op": e.get("op") or ""}
        if name:
            ASN_NAME[asn] = name


def resolve_asns(items: Iterable) -> list[int]:
    """把混合列表 (int / 数字串) 解析成去重 ASN int 列表 (保序)。非数字项忽略。"""
    out: list[int] = []
    seen: set[int] = set()
    for it in items or []:
        if isinstance(it, bool):
            continue
        if isinstance(it, int):
            n = it
        else:
            s = str(it).strip()
            if not s.isdigit():
                continue
            n = int(s)
        if n not in seen:
            seen.add(n); out.append(n)
    return out


def clean_path(asns: Iterable[int]) -> list[int]:
    """折叠连续重复 (AS prepend), 保留顺序。"""
    out: list[int] = []
    for a in asns:
        if not out or out[-1] != a:
            out.append(a)
    return out


def path_contains_seq(path: list[int], seq: list[int]) -> bool:
    """seq 是否作为 path 的**连续子序列**出现 (顺序且相邻)。

    单元素 seq 退化为"path 含该 ASN"。例: path=[1299,23764,4809] 含 [1299,23764]、
    [23764,4809]、[1299,23764,4809], 但不含 [1299,4809] (不相邻)。
    """
    if not seq:
        return True
    n, m = len(path), len(seq)
    if m > n:
        return False
    first = seq[0]
    for i in range(n - m + 1):
        if path[i] == first and path[i:i + m] == seq:
            return True
    return False


def asn_name(asn: int) -> str:
    return ASN_NAME.get(asn, "")


def fmt_asn(asn: int) -> str:
    name = ASN_NAME.get(asn)
    return f"{asn}({name})" if name else str(asn)


def fmt_path(asns: Iterable[int]) -> str:
    return " ".join(fmt_asn(a) for a in asns)


# 注: 早期的 collapse_multihome(把 per-peer pathobs 聚合成去重路径)已删除 —— 去重现在在
# ingest 时完成(pathobs 直接存去重路径 + n_peers), report.insight / build._paths_all 直接读。
