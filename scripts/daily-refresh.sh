#!/usr/bin/env bash
# PEER.AS 每日数据刷新 + 部署
# ──────────────────────────────────────────────────────────────────────────
# 由 fcron 每天 04:00 触发（见 `fcrontab -l`）。完整工作流（AGENTS.md「数据维护流程」）：
#   1) ./ipc ingest --reset        下载 rrc01+rrc06 最新 RIB(各~350MB), 全表 v4+v6 入 DuckDB 工作库;
#                                   并检查 GeoLite 是否过期(过期才下+重建 geo, 否则复用)
#   2) ./ipc export-parquet --out dist   DuckDB -> Parquet(v4+v6) + SSG -> dist/
#   3a) 同步**整个 dist(前端+数据+打包的 duckdb wasm)** -> CN 机器(cn.peer.as, 与 peer.as 一致的独立整站)
#   3b) wrangler pages deploy dist -> CF Pages(peer.as): 前端 + **同源数据 /data**
# 架构(2026-06 起): **数据全部同源, 不再用 R2**(前端整片下载、不靠 Range, R2 无收益却有被刷爆账单风险)。
#   海外: peer.as = CF Pages, 数据走自己的 /data。境内(GeoDNS): peer.as 解到 CN 机器, 同源即 CN 机器。
#   前端 db.js 按域名/geo 选源(见 AGENTS.md)。
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

  echo "[$(date -Is)] 2/3 export-parquet --out dist"
  ./ipc export-parquet --out dist

  # 架构(2026-06 起): **不再用 R2**。数据全部同源 —— 海外走 CF Pages 的 /data, 境内走 CN 机器(cn.peer.as,
  # 与 peer.as 目录一致的整站)。前端 db.js 按域名/geo 选源(见 AGENTS.md「同源数据分发」)。
  # 前端实际整片下载分片、不靠 Range, R2 无收益却有被刷爆 egress 账单风险 -> 弃用。

  # 3a) 同步**整个 dist(前端 + 数据 + 打包的 duckdb wasm/worker, 在 dist/assets)** -> CN 机器,
  #     使 cn.peer.as 成为与 peer.as 完全一致的独立整站。best-effort(CN 加速层, 失败不阻断, 境内回退 CF)。
  #     wasm 现随 dist 自动同步, 无需保留 /duckdb(旧自托管目录已废, --delete 会清掉)。
  #     数据先传、meta.json 最后传(原子: 版本源最后切)。
  if [ -n "${CN_DEPLOY_SSH:-}" ]; then
    CNPATH="${CN_DEPLOY_PATH:-/var/www/cn}"
    RSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
    echo "[$(date -Is)] 3a/3 rsync 整站 dist/ -> ${CN_DEPLOY_SSH}:${CNPATH}/"
    if rsync -a --delete --exclude='data/meta.json' -e "$RSH" "$PROJ/dist/" "${CN_DEPLOY_SSH}:${CNPATH}/" \
       && rsync -a -e "$RSH" "$PROJ/dist/data/meta.json" "${CN_DEPLOY_SSH}:${CNPATH}/data/meta.json"; then
      echo "  ✓ CN 机器整站同步完成(meta.json 最后传)"
    else
      echo "  ⚠ CN 机器同步失败(境内用户将回退 CF), 不阻断部署"
    fi
  else
    echo "[$(date -Is)] 3a/3 跳过 CN 同步：未设置 CN_DEPLOY_SSH"
  fi

  # 3b) CF Pages 部署。**CF 单文件 ≤25MiB**, 而 duckdb-eh/mvp.wasm 达 33/39MB -> 用 .assetsignore 排除上传
  #     (CF 路径下前端 wasmSrcs 同源取不到时回退外部 CDN; CN 镜像走 rsync 的完整 wasm, 不受此影响)。
  echo "[$(date -Is)] 3b/3 wrangler pages deploy(前端 + 同源数据 -> peer.as; 排除超限 wasm)"
  printf '*.wasm\n' > dist/.assetsignore
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
