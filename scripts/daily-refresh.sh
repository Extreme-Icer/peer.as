#!/usr/bin/env bash
# scripts/daily-refresh.sh — fcron 入口（见 `fcrontab -l`）。**薄封装**：实际工作全在 scripts/deploy.sh。
# 本脚本只负责日志文件 + 轮转。= 全量刷新：deploy.sh --data（清缓存 → ingest --reset → export → build → 部署）。
# 并发互斥 / PATH / HOME / .env / 校验等都在 deploy.sh 内（cron 与手动共用同一份逻辑，结果一致）。
# **多实例**：PROJ 从脚本位置推导（不写死），peeras 与 dn42 各自 checkout 用同一份脚本。保留份数 REFRESH_KEEP（默认 45）。
#   - peeras：每 8 小时（本地 00:40/08:40/16:40，对齐 RIPE RIS bview 发布 UTC 00/08/16 + 40min 延迟；名叫 daily 是历史遗留）。
#   - dn42：每 10 分钟（对齐 dn42 GRC 10min 发布；cron 行前置 REFRESH_KEEP=144）。
set -euo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="$PROJ/logs"; mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"; LOG="$LOGDIR/daily-refresh-$TS.log"
KEEP="${REFRESH_KEEP:-45}"

if "$PROJ/scripts/deploy.sh" --data >>"$LOG" 2>&1; then
  echo "[$(date -Is)] daily-refresh OK" >>"$LOG"; status=OK
else
  status="FAILED(exit=$?)"; echo "[$(date -Is)] daily-refresh $status" >>"$LOG"
fi

# 只保留最近 KEEP 份日志
ls -1t "$LOGDIR"/daily-refresh-*.log 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
[ "$status" = OK ]
