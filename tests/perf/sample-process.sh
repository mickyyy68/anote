#!/usr/bin/env bash
set -euo pipefail

OUT=""
PID=""
MATCH="target/debug/anote"
INTERVAL="1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT="$2"
      shift 2
      ;;
    --pid)
      PID="$2"
      shift 2
      ;;
    --match)
      MATCH="$2"
      shift 2
      ;;
    --interval)
      INTERVAL="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$OUT" ]]; then
  echo "Missing required --out <csv-path>" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
echo "timestamp,pid,cpu_pct,rss_mb,threads" > "$OUT"

thread_count() {
  local pid="$1"

  # macOS `ps` does not support `thcount`; derive thread count from `ps -M` rows.
  ps -M -p "$pid" 2>/dev/null | awk 'NR > 1 { c += 1 } END { print c + 0 }'
}

resolve_pid() {
  local explicit_pid="$1"
  local match_expr="$2"

  if [[ -n "$explicit_pid" ]]; then
    echo "$explicit_pid"
    return
  fi

  local found
  found=$(pgrep -f "$match_expr" | head -n 1 || true)
  echo "$found"
}

while true; do
  CUR_PID=$(resolve_pid "$PID" "$MATCH")

  if [[ -z "$CUR_PID" ]]; then
    sleep "$INTERVAL"
    continue
  fi

  ROW=$(ps -p "$CUR_PID" -o pid=,%cpu=,rss= 2>/dev/null || true)
  if [[ -z "$ROW" ]]; then
    sleep "$INTERVAL"
    continue
  fi

  PID_VAL=$(echo "$ROW" | awk '{print $1}')
  CPU_VAL=$(echo "$ROW" | awk '{print $2}')
  RSS_KB=$(echo "$ROW" | awk '{print $3}')
  THREADS=$(thread_count "$CUR_PID")
  RSS_MB=$(awk -v rss="$RSS_KB" 'BEGIN { printf "%.3f", rss/1024 }')

  TS=$(date +"%Y-%m-%dT%H:%M:%S%z")
  echo "$TS,$PID_VAL,$CPU_VAL,$RSS_MB,$THREADS" >> "$OUT"

  sleep "$INTERVAL"
done
