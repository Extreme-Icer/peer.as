#!/usr/bin/env bash
# PEER.AS 每日数据刷新 + 部署
# ──────────────────────────────────────────────────────────────────────────
# 由 fcron 每天 04:00 触发（见 `fcrontab -l`）。完整工作流（AGENTS.md「数据维护流程」）：
#   1) ./ipc ingest --reset        下载 rrc01+rrc06 最新 RIB(各~350MB), 全表 v4+v6 入 DuckDB 工作库;
#                                   并检查 GeoLite 是否过期(过期才下+重建 geo, 否则复用)
#   2) ./ipc export-parquet --out dist   DuckDB -> Parquet(v4+v6) + SSG -> dist/
#   3) 同步 dist/data -> R2 桶 $R2_BUCKET(海外前端读 data.peer.as; 数据先传、meta.json 最后传)
#   4) 同步 dist/data -> 中国优化 VPS(cn.peer.as, best-effort; CN 前端读它, 见 AGENTS.md「中国优化」)
#   5) wrangler pages deploy ...    部署到 Cloudflare Pages 项目 bgp-insights(域名 peer.as)
# 前端已切 R2 数据源(VITE_DATA_BASE=https://data.peer.as)⇒ 步骤 3 不可省, 否则每日新数据进不了 R2。
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

  # 0/3 先清缓存：每次新开都把旧 MRT(每版 ~350MB×2) + duck 溢出残留删掉，否则日积月累撑爆硬盘。
  # 只删大且每次重生的：cache/mrt 旧 RIB(ingest 会重新下最新) 与 cache/duck_tmp(export/ingest 溢出+obs CSV)。
  # **保留 cache/geo/(GeoLite mmdb + 版本戳)**：ingest 内按过期检查决定是否重下, 勿每次删(否则每天重下重建 geo)。
  # 保留 cache/autnums.txt(12MB, ASN 名表, 复用省下载)。
  echo "[$(date -Is)] 0/3 清理旧缓存(mrt/duck_tmp; 保留 geo), 防撑爆硬盘"
  rm -f  "$PROJ"/cache/mrt/*.gz "$PROJ"/cache/mrt/*.part "$PROJ"/cache/mrt/dl.log
  rm -rf "$PROJ"/cache/duck_tmp/* 2>/dev/null || true

  echo "[$(date -Is)] 1/3 ingest --reset"
  ./ipc ingest --reset

  echo "[$(date -Is)] 2/5 export-parquet --out dist"
  ./ipc export-parquet --out dist

  # 3/4 同步到 R2：前端已读 data.peer.as ⇒ 新数据必须进桶。R2 逐对象上传非原子，
  # 故「数据先传、meta.json 最后传」：meta 是 version 源，若数据没传全就跳过 meta，
  # R2 维持上一致版本(宁可旧也别 version/分片错位)。单文件最多重试 3 次抗瞬时限流。
  echo "[$(date -Is)] 3/5 sync dist/data -> R2 (${R2_BUCKET:-未配置})"
  if [ -n "${R2_BUCKET:-}" ]; then
    FAILS="$LOGDIR/r2-fails-$TS.txt"; : > "$FAILS"
    export R2_BUCKET FAILS
    ( cd "$PROJ/dist/data"
      find . -type f ! -name meta.json -printf '%P\n' | xargs -P 6 -I{} bash -c '
        k="$1"
        for i in 1 2 3; do wrangler r2 object put "$R2_BUCKET/$k" --file="$k" --remote >/dev/null 2>&1 && exit 0; sleep 2; done
        echo "$k" >> "$FAILS"' _ {} )
    n=$(wc -l < "$FAILS" | tr -d ' ')
    if [ "$n" -gt 0 ]; then
      echo "  ⚠ R2 有 $n 个文件失败(见 $FAILS)，跳过 meta.json ⇒ R2 维持上一致版本"
    else
      for i in 1 2 3; do
        wrangler r2 object put "$R2_BUCKET/meta.json" --file="$PROJ/dist/data/meta.json" --remote >/dev/null 2>&1 && break
        sleep 2
      done
      echo "  ✓ R2 同步完成(meta.json 最后传)"; rm -f "$FAILS"
    fi
  else
    echo "  跳过：未设置 R2_BUCKET（前端将回退同源 dist/data）"
  fi

  # 4/5 同步 dist/data -> 中国优化 VPS(cn.peer.as)。best-effort: VPS 只是 CN 加速层, 同步失败
  # 不阻断部署(CN 用户会自动回退 CF/R2)。数据先传、meta.json 最后传(同 R2 的原子性语义)。
  # 目标走 .env 的 CN_DEPLOY_SSH(如 root@<ip>)/CN_DEPLOY_PATH, 不写进提交文件(脱敏)。
  # 注: duckdb wasm(/duckdb)不在 dist 内, 仅 duckdb 版本升级时在 VPS 上手动重置(见 AGENTS.md)。
  if [ -n "${CN_DEPLOY_SSH:-}" ]; then
    CNPATH="${CN_DEPLOY_PATH:-/var/www/cn}"
    RSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
    echo "[$(date -Is)] 4/5 rsync dist/data -> ${CN_DEPLOY_SSH}:${CNPATH}/data"
    if rsync -a --delete --exclude=meta.json -e "$RSH" "$PROJ/dist/data/" "${CN_DEPLOY_SSH}:${CNPATH}/data/" \
       && rsync -a -e "$RSH" "$PROJ/dist/data/meta.json" "${CN_DEPLOY_SSH}:${CNPATH}/data/meta.json"; then
      echo "  ✓ VPS 数据同步完成(meta.json 最后传)"
    else
      echo "  ⚠ VPS 数据同步失败(CN 用户将回退 CF/R2), 不阻断部署"
    fi
  else
    echo "[$(date -Is)] 4/5 跳过 VPS 同步：未设置 CN_DEPLOY_SSH"
  fi

  echo "[$(date -Is)] 5/5 wrangler pages deploy"
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
