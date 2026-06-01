#!/usr/bin/env bash
# PEER.AS 每日数据刷新 + 部署
# ──────────────────────────────────────────────────────────────────────────
# 由 fcron 每天 04:00 触发（见 `fcrontab -l`）。完整工作流（AGENTS.md「数据维护流程」）：
#   1) ./ipc ingest --reset        下载 rrc00 最新 RIB(~400MB), 全表 v4 入库(~12min, db ~3GB)
#   2) ./ipc export-parquet --out dist   SQLite -> Parquet + SSG -> dist/(~2.5min)
#   3) wrangler pages deploy ...    部署到 Cloudflare Pages 项目 bgp-insights(域名 peer.as)
# 不跑 npm build：前端源每日不变，web/dist/ 已存在并由 export-parquet 拷进 dist/。
# 改了前端时需人工先 `cd ipcollect/web && npm run build`（见 AGENTS.md）。
set -euo pipefail

# cron 的 PATH 极简，显式补齐 node-24（wrangler/npm）与系统目录；HOME 供 wrangler 读 OAuth 凭据
export HOME="${HOME:-/home/aosc}"
export PATH="/usr/lib/node-24/bin:/usr/local/bin:/usr/bin:/bin"

PROJ="/home/aosc/test-ip-collect"
cd "$PROJ"

LOGDIR="$PROJ/logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOG="$LOGDIR/daily-refresh-$TS.log"

# 串行锁：上一次没跑完（ingest 很重）就跳过本次，避免并发重 ingest 撕裂数据库
exec 9>"$LOGDIR/daily-refresh.lock"
if ! flock -n 9; then
  echo "[$(date -Is)] 上一次刷新仍在运行，跳过本次。" >>"$LOG"
  exit 0
fi

run() {
  echo "===== PEER.AS 每日刷新 $TS ====="
  # 可选：若有 .env（CF 凭据 / IPC_IPDB_PATH 覆盖）则加载。当前用 wrangler OAuth，无需 .env。
  [ -f "$PROJ/.env" ] && { set -a; . "$PROJ/.env"; set +a; }

  # 0/3 先清缓存：每次新开都把旧 MRT(每版 ~425MB) + duck 溢出残留删掉，否则日积月累撑爆硬盘。
  # 只删大且每次重生的：cache/mrt 旧 RIB(ingest 会重新下最新) 与 cache/duck_tmp(export 溢出)。
  # 保留 cache/autnums.txt(12MB, ASN 名表, 复用省下载)。删完再下载 ⇒ 同时只存 1 份 RIB。
  echo "[$(date -Is)] 0/3 清理旧缓存(mrt/duck_tmp), 防撑爆硬盘"
  rm -f  "$PROJ"/cache/mrt/*.gz "$PROJ"/cache/mrt/dl.log
  rm -rf "$PROJ"/cache/duck_tmp/* 2>/dev/null || true

  echo "[$(date -Is)] 1/3 ingest --reset"
  ./ipc ingest --reset

  echo "[$(date -Is)] 2/3 export-parquet --out dist"
  ./ipc export-parquet --out dist

  echo "[$(date -Is)] 3/3 wrangler pages deploy"
  wrangler pages deploy dist --project-name bgp-insights --branch main --commit-dirty=true

  echo "[$(date -Is)] 完成 ✅"
}

if run >>"$LOG" 2>&1; then
  status="OK"
else
  status="FAILED(exit=$?)"
  echo "[$(date -Is)] 失败 ❌ $status" >>"$LOG"
fi

# 只保留最近 14 份日志
ls -1t "$LOGDIR"/daily-refresh-*.log 2>/dev/null | tail -n +15 | xargs -r rm -f

[ "$status" = "OK" ]
