#!/usr/bin/env bash
# scripts/daily-refresh.sh — fcron 04:00 入口（见 `fcrontab -l`）。
# **薄封装**：实际工作全在 scripts/deploy.sh。本脚本只负责日志文件 + 14 份轮转。
# = 每日全量：deploy.sh --data（清缓存 → ingest --reset v4+v6 → export-parquet → npm build → 部署 CF+CN）。
# 并发互斥 / PATH / HOME / .env 加载 / 校验 等都在 deploy.sh 内（cron 与手动共用同一份逻辑，结果一致）。
set -euo pipefail

PROJ="/home/aosc/test-ip-collect"
LOGDIR="$PROJ/logs"; mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"; LOG="$LOGDIR/daily-refresh-$TS.log"

if "$PROJ/scripts/deploy.sh" --data >>"$LOG" 2>&1; then
  echo "[$(date -Is)] daily-refresh OK" >>"$LOG"; status=OK
else
  status="FAILED(exit=$?)"; echo "[$(date -Is)] daily-refresh $status" >>"$LOG"
fi

# 只保留最近 14 份日志
ls -1t "$LOGDIR"/daily-refresh-*.log 2>/dev/null | tail -n +15 | xargs -r rm -f
[ "$status" = OK ]
