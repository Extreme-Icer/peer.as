#!/usr/bin/env bash
# scripts/vendor-duckdb-ext.sh — 把 pinned DuckDB **parquet 扩展**(wasm_eh + wasm_mvp)下载到
# ipcollect/web/public/duckdb-ext/<EXTVER>/wasm_<plat>/parquet.duckdb_extension.wasm（gitignored）。
# 用途：自托管扩展，避免 read_parquet 运行时从 extensions.duckdb.org 跨境拉（首查卡 ~2s）。
# 这些文件经 vite(public/) → web/dist → copy_web → dist → 部署到 CF + CN（见 db.js extRepoBase / deploy.sh）。
#
# **EXTVER = DuckDB 引擎版本**（非 npm 版本！）。引擎按 `${repo}/${EXTVER}/wasm_<plat>/<name>.duckdb_extension.wasm`
# 取扩展；当前 duckdb-wasm npm 1.32.0 对应引擎 **v1.4.3**。**升级 duckdb-wasm 时**：同步改这里 EXTVER + db.js DUCKDB_VER，
# 并删旧 public/duckdb-ext/ 让本脚本重下（否则引擎请求新版本路径而文件是旧版 -> 扩展加载失败、回退官方源）。
set -euo pipefail

EXTVER="${1:-v1.4.3}"
# PROJ = 本脚本所在仓库根(从脚本位置推导, 不写死) —— peeras / dn42 各自 checkout 都能用同一份脚本。
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$PROJ/ipcollect/web/public/duckdb-ext/$EXTVER"
BASE="https://extensions.duckdb.org/$EXTVER"

for plat in wasm_eh wasm_mvp; do
  f="$DEST/$plat/parquet.duckdb_extension.wasm"
  if [ -s "$f" ]; then continue; fi          # 已 vendor 过则跳过（pinned，不变）
  mkdir -p "$DEST/$plat"
  echo "[vendor-duckdb-ext] 下载 $plat/parquet.duckdb_extension.wasm ($EXTVER)"
  curl -fsS "$BASE/$plat/parquet.duckdb_extension.wasm" -o "$f.tmp"
  # 校验确是 wasm（magic 00 61 73 6d），否则丢弃（防把错误页/空文件 vendor 进去）
  if [ "$(head -c4 "$f.tmp" | xxd -p 2>/dev/null)" = "0061736d" ]; then
    mv "$f.tmp" "$f"
  else
    rm -f "$f.tmp"; echo "[vendor-duckdb-ext] ERROR: $plat 下载非 wasm，放弃" >&2; exit 1
  fi
done
echo "[vendor-duckdb-ext] ✓ parquet 扩展就位: $DEST/{wasm_eh,wasm_mvp}/"
