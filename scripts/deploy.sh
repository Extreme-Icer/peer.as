#!/usr/bin/env bash
# scripts/deploy.sh — PEER.AS 唯一部署入口（cron / 手动 / 开发都走这里，结果完全一致）。
# 用法: scripts/deploy.sh [--data] [--no-build] [--cf-only|--cn-only]
#   (无 flag)   build 前端 + 部署两端（复用现有 dist/data）   —— 改了前端后推送 / 只动前端
#   --data      先 ingest --reset + export-parquet 重建数据，再 build + 部署 —— daily refresh / 全重推数据
#   --no-build  跳过 npm build，用现有 web/dist（少用；纯重新部署现有 dist）
#   --cf-only / --cn-only   只部署一端（默认 CF + CN 两端都部署）
# 设计：数据(ingest+export)、前端(build)、部署(CF+CN) 三段；部署核心只实现这一份。
set -euo pipefail

PROJ="/home/aosc/test-ip-collect"
cd "$PROJ"

# cron 直接调用时 PATH/HOME 极简，补齐 node-24（npm/wrangler）与系统目录；HOME 供 wrangler 读 OAuth、ssh 读密钥。
export HOME="${HOME:-/home/aosc}"
case ":$PATH:" in *":/usr/lib/node-24/bin:"*) ;; *) export PATH="/usr/lib/node-24/bin:/usr/local/bin:/usr/bin:/bin:$PATH" ;; esac
# .env: CN_DEPLOY_SSH/CN_DEPLOY_PATH（CN VPS）、可选 CF 凭据覆盖。
[ -f "$PROJ/.env" ] && { set -a; . "$PROJ/.env"; set +a; }

usage(){ cat <<'EOF'
scripts/deploy.sh — PEER.AS 唯一部署入口（cron / 手动 / 开发都走这里，结果一致）。
用法: scripts/deploy.sh [--data] [--no-build] [--cf-only|--cn-only]
  (无 flag)   build 前端 + 部署两端（复用现有 dist/data）       改了前端后推送 / 只动前端
  --data      ingest --reset + export-parquet 重建数据，再 build + 部署   daily refresh / 全重推数据
  --no-build  跳过 npm build，用现有 web/dist（纯重新部署现有 dist）
  --cf-only / --cn-only   只部署一端（默认 CF + CN 两端）
EOF
}

WITH_DATA=0; DO_BUILD=1; TARGET=both
for a in "$@"; do case "$a" in
  --data)     WITH_DATA=1 ;;
  --no-build) DO_BUILD=0 ;;
  --cf-only)  TARGET=cf ;;
  --cn-only)  TARGET=cn ;;
  -h|--help)  usage; exit 0 ;;
  *) echo "未知参数: $a（见 --help）" >&2; exit 2 ;;
esac; done

log(){ echo "[$(date -Is)] $*"; }

mkdir -p "$PROJ/logs"
# 防并发：cron 与手动互斥（上一次没跑完就退出，避免并发重 ingest 撕裂 DB / 半成品 dist 被部署）。
exec 9>"$PROJ/logs/deploy.lock"
if ! flock -n 9; then log "另一次 deploy 仍在运行，退出。"; exit 0; fi

log "deploy 开始: data=$WITH_DATA build=$DO_BUILD target=$TARGET"

# ── 1) 数据（可选）──────────────────────────────────────────────────────────
if [ "$WITH_DATA" = 1 ]; then
  # 清缓存：旧 MRT(每版 ~350MB×2) + duck 溢出残留，否则日积月累撑爆硬盘。保留 cache/geo(GeoLite + 版本戳)。
  log "数据 1/2: 清缓存(mrt/duck_tmp; 保留 geo)"
  rm -f  "$PROJ"/cache/mrt/*.gz "$PROJ"/cache/mrt/*.part "$PROJ"/cache/mrt/dl.log 2>/dev/null || true
  rm -rf "$PROJ"/cache/duck_tmp/* 2>/dev/null || true
  log "数据 2/2: ipc ingest --reset（全表 v4+v6）→ export-parquet"
  ./ipc ingest --reset
  ./ipc export-parquet --out dist
fi

# ── 2) 前端 ────────────────────────────────────────────────────────────────
# export-parquet 只产数据/SSG、不拷前端（copy_web 在 build/sync-web 里），故前端步骤独立、在数据之后。
# 默认总是 npm build：保证部署的前端永远是最新源码（消除"改了前端源却忘 build、部署旧前端"的事故类）。
if [ "$DO_BUILD" = 1 ]; then
  log "前端: vendor duckdb 扩展 + ipc build（npm run build + 拷 web/dist -> dist）"
  scripts/vendor-duckdb-ext.sh    # 确保 public/duckdb-ext/ 就位（pinned，已存在则秒过）-> vite 拷进 dist
  ./ipc build --out dist
else
  log "前端: --no-build，仅 ipc sync-web（拷已构建 web/dist -> dist）"
  ./ipc sync-web --out dist
fi

# ── 3) 部署核心（唯一实现）─────────────────────────────────────────────────
deploy_cn(){
  if [ -z "${CN_DEPLOY_SSH:-}" ]; then log "CN: 未设置 CN_DEPLOY_SSH，跳过"; return 0; fi
  local CNPATH="${CN_DEPLOY_PATH:-/var/www/cn}"
  local RSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
  # CN VPS（Caddy 无大小限制）托管**完整 dist 含 wasm**。--delete 清掉本地没有的旧文件（含已废 /duckdb）。
  # meta.json 最后单独传（原子切版本：数据分片先到位再切版本号）。best-effort，失败不阻断（境内回退 CF）。
  log "CN: rsync 整站 dist/ -> ${CN_DEPLOY_SSH}:${CNPATH}/（含完整 wasm；meta.json 最后传）"
  if rsync -a --delete --exclude='data/meta.json' -e "$RSH" "$PROJ/dist/" "${CN_DEPLOY_SSH}:${CNPATH}/" \
     && rsync -a -e "$RSH" "$PROJ/dist/data/meta.json" "${CN_DEPLOY_SSH}:${CNPATH}/data/meta.json"; then
    log "CN: ✓ 同步完成"
  else
    log "CN: ⚠ 同步失败（境内回退 CF，不阻断）"
  fi
}
deploy_cf(){
  # CF Pages 单文件 ≤25MiB，而 duckdb-eh/mvp.wasm 达 33/39MB（pages deploy 不认 .assetsignore）。
  # 故部署前临时移出 *.wasm、部署后移回（CF 路径前端 wasmSrcs 走 CDN 取 wasm；worker/数据照常同源）。
  # 用显式 move-back（非 trap）：即便 wrangler 失败也保证移回、且把退出码透传。
  local HOLD; HOLD="$(mktemp -d)"; local rc=0
  mv "$PROJ"/dist/assets/*.wasm "$HOLD"/ 2>/dev/null || true
  log "CF: wrangler pages deploy（排除超限 wasm；CF 节点 wasm 回退 CDN）"
  wrangler pages deploy dist --project-name bgp-insights --branch main --commit-dirty=true \
    --commit-message="deploy.sh $([ "$WITH_DATA" = 1 ] && echo 'data+web' || echo web)" || rc=$?
  mv "$HOLD"/*.wasm "$PROJ"/dist/assets/ 2>/dev/null || true
  rmdir "$HOLD" 2>/dev/null || true
  return $rc
}
[ "$TARGET" != cf ] && deploy_cn
[ "$TARGET" != cn ] && deploy_cf

# ── 4) 部署后轻量校验（防回归：两端入口一致 + CN wasm 自托管）─────────────────
verify(){
  local le; le="$(grep -o 'assets/index-[^\"]*\.js' dist/index.html | head -1)"
  log "校验: 本地入口 = $le"
  for h in peer.as cn.peer.as; do
    { [ "$TARGET" = cf ] && [ "$h" = cn.peer.as ]; } && continue
    { [ "$TARGET" = cn ] && [ "$h" = peer.as ]; } && continue
    local got; got="$(curl -fsS --max-time 15 "https://$h/" 2>/dev/null | grep -o 'assets/index-[^\"]*\.js' | head -1 || true)"
    if [ "$got" = "$le" ]; then log "校验: ✓ $h 入口一致"; else log "校验: ⚠ $h 入口=${got:-空}（缓存/传播中?需复查）"; fi
  done
  if [ "$TARGET" != cf ]; then
    local w; w="$(ls "$PROJ"/dist/assets/duckdb-eh-*.wasm 2>/dev/null | head -1 | xargs -r basename || true)"
    if [ -n "$w" ]; then
      local ct; ct="$(curl -fsSI --max-time 20 "https://cn.peer.as/assets/$w" 2>/dev/null | grep -i '^content-type:' | tr -d '\r' || true)"
      case "$ct" in *application/wasm*) log "CN: ✓ wasm 自托管（$ct）" ;; *) log "CN: ⚠ wasm $ct（应为 application/wasm）" ;; esac
    fi
  fi
  # **关键**: parquet 扩展自托管校验（防 CF SPA-200 把 HTML 当扩展）。校验每个已部署端的扩展实际返回 wasm magic。
  # rel = duckdb-ext/<引擎版本>/wasm_eh/parquet.duckdb_extension.wasm（从 dist 取实际路径，免硬编码版本）。
  local rel; rel="$(cd "$PROJ/dist" 2>/dev/null && ls duckdb-ext/*/wasm_eh/parquet.duckdb_extension.wasm 2>/dev/null | head -1 || true)"
  if [ -n "$rel" ]; then
    for h in peer.as cn.peer.as; do
      { [ "$TARGET" = cf ] && [ "$h" = cn.peer.as ]; } && continue
      { [ "$TARGET" = cn ] && [ "$h" = peer.as ]; } && continue
      local magic; magic="$(curl -fsS --max-time 25 "https://$h/$rel" 2>/dev/null | head -c4 | xxd -p 2>/dev/null || true)"
      if [ "$magic" = "0061736d" ]; then log "扩展: ✓ $h parquet 扩展自托管（wasm magic 正确）"
      else log "扩展: ⚠ $h parquet 扩展 magic=${magic:-空}（非 wasm！前端会回退官方源，请查 $rel 是否部署）"; fi
    done
  else
    log "扩展: ⚠ dist/duckdb-ext 缺失（vendor 未跑?）—— 前端将回退官方 extensions.duckdb.org"
  fi
}
verify || true
log "完成 ✅"
