"""dn42 registry(全量 whois)采集 + RPSL 解析。**仅 dn42 站(site=dn42)用**。

registry = 一堆 RPSL 扁平文件(`data/<type>/<key>`), 取代公网站的 APNIC autnums + GeoLite org + 在线 RDAP:
  - aut-num/AS<n>      ASN 注册(as-name, admin-c, tech-c, mnt-by) -> ASN 名 + 负责人(person)
  - person/<nic-hdl>   联系人(person 显示名, e-mail) -> 「按 person 筛选」导航 + whois
  - mntner/<id>        维护者(admin-c) -> aut-num 无 admin-c 时的兜底负责人
  - route(6)/<cidr>    路由对象(origin) -> ROA / 前缀 whois
  - inet(6)num/<range> 地址块(netname, descr) -> 前缀 whois

产出(供 parquet_export 在 site=dn42 时取用):
  asn_names {asn:int -> as-name}      ; asn_person {asn:int -> nic-hdl}
  person_name {nic-hdl -> 显示名}      ; objects {type -> {key -> [(attr,val), ...]}}(原始有序属性, 喂前端 whois)
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Optional

from . import util

# RPSL 属性行: "key:   value"。续行(以空白起、无 key)接到上一属性值。
_ATTR_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_-]*):\s*(.*)$")

# 导出给前端 whois 的对象类型(原始属性按序保留)。auth/PGP 等敏感/无用字段在序列化时剔除。
WHOIS_TYPES = ("aut-num", "person", "mntner", "organisation", "role",
               "inetnum", "inet6num", "route", "route6", "as-set", "dns")
# 不下发到前端的属性(认证材料 / 噪音)。
_DROP_ATTRS = {"auth", "pgp-fingerprint"}


def ensure_registry(cfg: dict) -> Path:
    """clone/pull registry git 仓到 cache/dn42-registry; 返回其 `data/` 目录。
    best-effort: 已存在则尝试更新(失败用旧的); 无仓且无 registry_repo 则报错。"""
    dest = util.CACHE_DIR / "dn42-registry"
    repo = (cfg.get("registry_repo") or "").strip()
    if (dest / ".git").exists():
        if repo:
            try:
                subprocess.run(["git", "-C", str(dest), "fetch", "--depth", "1", "origin"],
                               check=True, capture_output=True, timeout=180)
                subprocess.run(["git", "-C", str(dest), "reset", "--hard", "FETCH_HEAD"],
                               check=True, capture_output=True, timeout=60)
                util.log(f"  registry: 已更新 {dest}")
            except Exception as e:  # noqa: 更新失败用本地旧副本(不阻断)
                util.log(f"  ! registry 更新失败({e}); 用本地副本", err=True)
    elif repo:
        util.ensure_dirs()
        util.log(f"  registry: clone {repo} -> {dest}")
        subprocess.run(["git", "clone", "--depth", "1", repo, str(dest)],
                       check=True, capture_output=True, timeout=600)
    if not (dest / "data").is_dir():
        raise RuntimeError(f"registry 数据缺失: {dest}/data 不存在(设 registry_repo 或手动放置仓库)")
    return dest / "data"


def parse_object(text: str) -> list[tuple[str, str]]:
    """解析单个 RPSL 对象为有序 [(attr, value)]。可重复 attr 保留多条; 续行拼到上一条。"""
    rows: list[list] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        m = _ATTR_RE.match(line)
        if m:
            rows.append([m.group(1).lower(), m.group(2).strip()])
        elif rows and (line[0] in " \t+"):   # 续行
            cont = line.strip().lstrip("+").strip()
            if cont:
                rows[-1][1] = (rows[-1][1] + " " + cont).strip()
    return [(k, v) for k, v in rows]


def _first(rows: list[tuple[str, str]], key: str) -> Optional[str]:
    for k, v in rows:
        if k == key:
            return v
    return None


def _read_dir(data: Path, sub: str) -> dict[str, list[tuple[str, str]]]:
    d = data / sub
    out: dict[str, list[tuple[str, str]]] = {}
    if not d.is_dir():
        return out
    for f in d.iterdir():
        if f.is_file():
            try:
                out[f.name] = parse_object(f.read_text(encoding="utf-8", errors="replace"))
            except Exception:  # noqa: 单个坏对象不阻断
                continue
    return out


def load(cfg: dict) -> dict:
    """读取并解析整个 registry, 返回 ASN/person 映射 + 原始 whois 对象。"""
    data = ensure_registry(cfg)
    objects = {t: _read_dir(data, t) for t in WHOIS_TYPES}

    autnums = objects["aut-num"]
    persons = objects["person"]
    mntners = objects["mntner"]

    person_name: dict[str, str] = {}
    for nic, rows in persons.items():
        person_name[nic] = _first(rows, "person") or nic

    # mntner -> 其 admin-c(person), 作 aut-num 无 admin-c 时的兜底负责人
    mnt_admin: dict[str, str] = {}
    for mid, rows in mntners.items():
        mnt_admin[mid] = _first(rows, "admin-c") or _first(rows, "tech-c")

    asn_names: dict[int, str] = {}
    asn_person: dict[int, str] = {}
    for fn, rows in autnums.items():
        if not (fn.startswith("AS") and fn[2:].isdigit()):
            continue
        asn = int(fn[2:])
        nm = _first(rows, "as-name")
        if nm:
            asn_names[asn] = nm
        # 负责 person = aut-num.admin-c(优先) -> 兜底 mnt-by 的 mntner.admin-c
        pid = _first(rows, "admin-c") or _first(rows, "tech-c")
        if pid not in person_name:
            pid = mnt_admin.get(_first(rows, "mnt-by") or "")
        if pid in person_name:
            asn_person[asn] = pid

    util.log(f"  registry: {len(asn_names)} aut-num名 / {len(asn_person)} ASN→person / "
             f"{len(person_name)} person / 对象 " +
             ", ".join(f"{t}={len(objects[t])}" for t in WHOIS_TYPES if objects[t]))
    return {"asn_names": asn_names, "asn_person": asn_person,
            "person_name": person_name, "objects": objects}


def whois_record(rows: list[tuple[str, str]]) -> list[dict]:
    """把一个对象的原始属性序列化成前端 whois 行 [{key,value}](剔除认证字段)。"""
    return [{"key": k, "value": v} for k, v in rows if k not in _DROP_ATTRS]


def _asn_whois_model(asn: int, reg: dict) -> Optional[dict]:
    """构造与前端 rdap.normalize() 同形的 ASN whois 模型(head 行 + admin/tech/mnt 实体树)。"""
    objects = reg["objects"]
    person_name = reg["person_name"]
    autnum = objects["aut-num"].get(f"AS{asn}")
    if not autnum:
        return None
    ents: list[dict] = []
    seen_ent: set[tuple] = set()
    for role in ("admin-c", "tech-c"):
        for k, v in autnum:
            if k == role and v in objects["person"] and (role, v) not in seen_ent:
                seen_ent.add((role, v))
                ents.append({"handle": v, "roles": [role], "name": person_name.get(v, v),
                             "rows": whois_record(objects["person"][v]), "entities": []})
    for k, v in autnum:
        if k == "mnt-by" and v in objects["mntner"] and ("mnt", v) not in seen_ent:
            seen_ent.add(("mnt", v))
            ents.append({"handle": v, "roles": ["mnt-by"], "name": v,
                         "rows": whois_record(objects["mntner"][v]), "entities": []})
    return {"kind": "autnum", "key": str(asn), "title": _first(autnum, "as-name") or f"AS{asn}",
            "head": whois_record(autnum), "entities": ents, "remarks": [],
            "source": "DN42 Registry", "via": "registry"}


def _entities_for(rows: list, reg: dict) -> list[dict]:
    """从对象的 admin-c/tech-c(person) + mnt-by(mntner) 构造 whois 实体树(去重)。"""
    objects = reg["objects"]
    person_name = reg["person_name"]
    ents: list[dict] = []
    seen_ent: set[tuple] = set()
    for role in ("admin-c", "tech-c"):
        for k, v in rows:
            if k == role and v in objects["person"] and (role, v) not in seen_ent:
                seen_ent.add((role, v))
                ents.append({"handle": v, "roles": [role], "name": person_name.get(v, v),
                             "rows": whois_record(objects["person"][v]), "entities": []})
    for k, v in rows:
        if k == "mnt-by" and v in objects["mntner"] and ("mnt", v) not in seen_ent:
            seen_ent.add(("mnt", v))
            ents.append({"handle": v, "roles": ["mnt-by"], "name": v,
                         "rows": whois_record(objects["mntner"][v]), "entities": []})
    return ents


def _domain_whois_model(domain: str, rows: list, reg: dict) -> dict:
    """dns 对象 -> 与前端同形的 domain whois 模型(nserver 作 head 行, admin/tech/mnt 实体树)。"""
    return {"kind": "domain", "key": domain, "title": domain,
            "head": whois_record(rows), "entities": _entities_for(rows, reg), "remarks": [],
            "source": "DN42 Registry", "via": "registry"}


def export_dn42(reg: dict, data_dir: Path, seen: set, con) -> tuple[list, dict]:
    """写出 dn42 静态 whois(逐 ASN JSON) + 算 person 导航数据。

    返回 (persons_meta, asn_person_meta):
      persons_meta = [{id, name, asns:[...], n_prefix}]  按前缀数降序(侧栏导航)
      asn_person_meta = {str(asn): nic-hdl}  (seen origin → person; 前端按此把前缀归到 person)
    """
    asn_person = reg["asn_person"]
    person_name = reg["person_name"]

    # 每 origin ASN 的前缀数(person 计数用)
    cnt = {int(a): int(c) for a, c in con.execute(
        "SELECT origin_asn, count(*) FROM prefix WHERE origin_asn IS NOT NULL GROUP BY origin_asn").fetchall()}

    persons: dict[str, dict] = {}
    asn_person_seen: dict[str, str] = {}
    for asn in seen:
        pid = asn_person.get(asn)
        if not pid:
            continue
        asn_person_seen[str(asn)] = pid
        p = persons.setdefault(pid, {"asns": set(), "n_prefix": 0})
        p["asns"].add(asn)
        p["n_prefix"] += cnt.get(asn, 0)
    persons_meta = sorted(
        ({"id": pid, "name": person_name.get(pid, pid),
          "asns": sorted(d["asns"]), "n_prefix": d["n_prefix"]}
         for pid, d in persons.items()),
        key=lambda x: (-x["n_prefix"], x["name"].lower()))

    # 逐 ASN whois JSON: data/registry/autnum/AS<asn>.json(前端按需 fetch, 取代在线 RDAP)
    regdir = data_dir / "registry" / "autnum"
    regdir.mkdir(parents=True, exist_ok=True)
    n = 0
    for asn in seen:
        model = _asn_whois_model(asn, reg)
        if model is None:
            continue
        (regdir / f"AS{asn}.json").write_text(
            json.dumps(model, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        n += 1

    # domain whois: 全量 dns 对象逐个写(主搜索框输入 *.dn42 -> registry whois, 取代公网 DoH/RDAP)。
    domdir = data_dir / "registry" / "domain"
    domdir.mkdir(parents=True, exist_ok=True)
    nd = 0
    for rows in reg["objects"].get("dns", {}).values():
        dom = (_first(rows, "domain") or "").strip().lower()
        if not dom or "/" in dom:
            continue
        (domdir / f"{dom}.json").write_text(
            json.dumps(_domain_whois_model(dom, rows, reg), ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8")
        nd += 1
    util.log(f"  registry whois: {n} autnum + {nd} domain JSON; persons: {len(persons_meta)}")
    return persons_meta, asn_person_seen
