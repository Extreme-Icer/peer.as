"""SQLite 存储层: schema 定义与连接助手。

设计要点:
  * prefix.start_num/end_num 用整数存, 配合 geo 表做范围归类。
  * pathobs 是每个 peer 观测到的去往该前缀的 AS_PATH (multihome / 等价路由 insight 的原料)。
  * path_asn 是 (asn -> prefix) 的倒排表, 让 "AS_PATH 含 58807" 这类查询走索引。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from . import util

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- ipdb.txt 导入的地理库 (按 start_num 升序, 二分/索引查找)
CREATE TABLE IF NOT EXISTS geo (
    start_num    INTEGER NOT NULL,
    end_num      INTEGER NOT NULL,
    country      TEXT,
    country_code TEXT,
    province     TEXT,
    city         TEXT,
    district     TEXT,
    isp          TEXT,
    lon          REAL,
    lat          REAL
);
CREATE INDEX IF NOT EXISTS idx_geo_start ON geo(start_num);

-- 焦点前缀 (origin 或 path 命中焦点 ASN)
CREATE TABLE IF NOT EXISTS prefix (
    id           INTEGER PRIMARY KEY,
    prefix       TEXT UNIQUE NOT NULL,
    start_num    INTEGER NOT NULL,
    end_num      INTEGER NOT NULL,
    family       INTEGER NOT NULL,
    plen         INTEGER NOT NULL,
    origin_asn   INTEGER,
    n_origins    INTEGER DEFAULT 1,
    country_code TEXT,
    province     TEXT,
    city         TEXT,
    isp          TEXT,
    geo_isp      TEXT,
    n_paths      INTEGER DEFAULT 0,
    ingest_ts    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_prefix_city   ON prefix(city);
CREATE INDEX IF NOT EXISTS idx_prefix_prov   ON prefix(province);
CREATE INDEX IF NOT EXISTS idx_prefix_origin ON prefix(origin_asn);
CREATE INDEX IF NOT EXISTS idx_prefix_start  ON prefix(start_num);

-- 去往该前缀的**去重 AS_PATH** (每前缀一行/条 distinct path + 观测它的 peer 数)。
-- 不存 per-peer 行: 全球全表下 per-peer 会爆到 ~40M 行; 去重后 ~5-15 路径/前缀。
-- n_peers = 观测到这条 path 的 peer 数 (multihome "等价路由" 的权重)。
CREATE TABLE IF NOT EXISTS pathobs (
    id         INTEGER PRIMARY KEY,
    prefix_id  INTEGER NOT NULL,
    path_clean TEXT,        -- 去连续重复(prepend)后的 path, 空格分隔
    path_len   INTEGER,
    origin_asn INTEGER,
    n_peers    INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pathobs_prefix ON pathobs(prefix_id);

-- 倒排: AS_PATH 中出现过的 ASN -> 前缀
CREATE TABLE IF NOT EXISTS path_asn (
    prefix_id INTEGER NOT NULL,
    asn       INTEGER NOT NULL,
    is_origin INTEGER DEFAULT 0,
    PRIMARY KEY (asn, prefix_id)
) WITHOUT ROWID;
"""


def connect(path: Path | None = None) -> sqlite3.Connection:
    p = path or util.DB_PATH
    conn = sqlite3.connect(str(p), timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-200000")  # ~200MB page cache
    return conn


def init_schema(conn: sqlite3.Connection, migrate: bool = False) -> None:
    """建表(IF NOT EXISTS)。migrate=True 时才做**破坏性**迁移(仅 ingest 调用)。

    pathobs 从 per-peer 旧 schema -> 去重路径新 schema(含 n_peers): 旧表 DROP 重建。
    migrate=False(只读命令)绝不 DROP —— 旧库会在读 n_peers 列时报错, 提示先 `ipc ingest --reset`,
    而不是被静默清空。
    """
    cols = {r[1] for r in conn.execute("PRAGMA table_info(pathobs)")}
    if migrate and cols and "n_peers" not in cols:
        conn.execute("DROP TABLE pathobs")
    conn.executescript(SCHEMA)
    conn.commit()


def get_meta(conn: sqlite3.Connection, key: str, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn: sqlite3.Connection, key: str, value) -> None:
    conn.execute(
        "INSERT INTO meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def table_count(conn: sqlite3.Connection, table: str) -> int:
    return conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]
