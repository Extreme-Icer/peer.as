"""通用工具: 路径解析, IP<->整数, CIDR, 日志."""
from __future__ import annotations

import ipaddress
import os
import sys
import time
from pathlib import Path

# 项目根目录 = 包目录的上一级 (即 /home/aosc/test-ip-collect)。
# 可用环境变量 IPC_HOME 覆盖, 让数据/缓存跟随安装位置。
ROOT = Path(os.environ.get("IPC_HOME", Path(__file__).resolve().parent.parent))

CONFIG_PATH = ROOT / "config.json"
DB_PATH = ROOT / "ipcollect.db"            # 旧 SQLite(退役中, Phase C 删)
DUCK_PATH = ROOT / "ipcollect.duckdb"      # DuckDB 工作库(ingest 中间态; 跑完即弃, 已 gitignore)
CACHE_DIR = ROOT / "cache"
MRT_CACHE_DIR = CACHE_DIR / "mrt"
GEO_CACHE_DIR = CACHE_DIR / "geo"          # GeoLite mmdb 缓存(随过期检查更新, daily-refresh 保留)
# geo 库路径: 默认项目根的 ipdb.txt, 可用 IPC_IPDB_PATH 覆盖(不入库的私有库)。
DEFAULT_IPDB = Path(os.environ.get("IPC_IPDB_PATH", ROOT / "ipdb.txt"))


def ensure_dirs() -> None:
    for d in (CACHE_DIR, MRT_CACHE_DIR, GEO_CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)


# ----------------------------------------------------------------------------
# IP <-> 整数
# ----------------------------------------------------------------------------
def ip2int(ip: str) -> int:
    return int(ipaddress.ip_address(ip))


def int2ip(n: int, v6: bool = False) -> str:
    return str(ipaddress.ip_address(n))


def is_v6(ip: str) -> bool:
    return ":" in ip


def cidr_bounds(cidr: str) -> tuple[int, int, int]:
    """返回 (start_int, end_int, family) ; family: 4 或 6."""
    net = ipaddress.ip_network(cidr, strict=False)
    return int(net.network_address), int(net.broadcast_address), net.version


# DuckDB 把 UHUGEINT(128位) 原生转 Python int / VARCHAR 极慢(实测 50k 行 16s, v6 全量分钟级)。
# 解法: 在 SQL 里把 UHUGEINT 拆成 hi/lo 两个 UBIGINT(64位, 原生快取), Python 端 hi*2^64+lo 还原。
SH64 = 1 << 64


def uhuge_halves(col: str) -> str:
    """SQL 片段: 把 UHUGEINT 列 col 拆成 (hi, lo) 两个 UBIGINT。配合 SH64 在 Python 端还原。"""
    return f"({col} // {SH64})::UBIGINT, ({col} % {SH64})::UBIGINT"


def prefix_from_bytes(pfx_bytes: bytes, plen: int, family: int) -> tuple[int, int, str]:
    """MRT 里前缀以 ceil(plen/8) 字节存储, 右侧补零得到网络地址."""
    addr_bytes = 4 if family == 4 else 16
    bits = addr_bytes * 8
    padded = pfx_bytes + b"\x00" * (addr_bytes - len(pfx_bytes))
    start = int.from_bytes(padded[:addr_bytes], "big")
    # 清掉主机位 (防御性)
    if plen < bits:
        mask = ((1 << plen) - 1) << (bits - plen)
        start &= mask
        end = start | ((1 << (bits - plen)) - 1)
    else:
        end = start
    ip = ipaddress.ip_address(start)
    cidr = f"{ip}/{plen}"
    return start, end, cidr


def hosts_in_prefix(cidr: str, limit: int | None = None, sample: bool = True):
    """枚举 CIDR 内可用主机 (跳过网络/广播地址)。可抽样。"""
    net = ipaddress.ip_network(cidr, strict=False)
    it = net.hosts() if net.num_addresses > 2 else iter([net.network_address])
    out = []
    for i, h in enumerate(it):
        if limit is not None and len(out) >= limit:
            break
        out.append(str(h))
    return out


# ----------------------------------------------------------------------------
# 日志 (轻量, 带时间戳, 输出到 stderr)
# ----------------------------------------------------------------------------
_T0 = time.time()
_QUIET = False


def set_quiet(q: bool) -> None:
    global _QUIET
    _QUIET = q


def log(msg: str, *, err: bool = False) -> None:
    if _QUIET and not err:
        return
    dt = time.time() - _T0
    prefix = "!" if err else "·"
    print(f"[{dt:7.1f}s] {prefix} {msg}", file=sys.stderr, flush=True)


def human(n: float) -> str:
    for unit in ("", "K", "M", "G", "T"):
        if abs(n) < 1000:
            return f"{n:.0f}{unit}" if unit == "" else f"{n:.1f}{unit}"
        n /= 1000.0
    return f"{n:.1f}P"


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024.0
    return f"{n:.1f}PB"


def download_file(url: str, dest, *, reuse: bool = False, timeout: int = 600) -> bool:
    """下载 url -> dest, 支持 **http(s) 与 ftp**(RADB 等只走 FTP; requests 不认 ftp:// -> 用 urllib 被动模式)。
    reuse=True 且本地已存在非空文件则跳过。http 连接超时 15s(避免死链长时间阻塞)。失败返回 False(不抛)。"""
    from pathlib import Path
    dest = Path(dest)
    if reuse and dest.exists() and dest.stat().st_size > 1000:
        return True
    try:
        if url.lower().startswith("ftp://"):
            import shutil
            import urllib.request
            with urllib.request.urlopen(url, timeout=timeout) as r, open(dest, "wb") as f:
                shutil.copyfileobj(r, f, length=1 << 20)
        else:
            import requests
            with requests.get(url, timeout=(15, timeout), stream=True) as resp:
                resp.raise_for_status()
                with open(dest, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=1 << 20):
                        f.write(chunk)
        return True
    except Exception as e:  # noqa
        log(f"  ! 下载失败({url}): {e}", err=True)
        return False
