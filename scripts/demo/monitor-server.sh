#!/usr/bin/env bash
# scripts/demo/monitor-server.sh
# 応援合戦デモ Phase 4：本番EC2監視スクリプト（岩村がTeraTermの別セッションで実行する想定）。
#
# 10秒ごとに、時刻（ISO8601）・load average・CPU内訳（user/system/iowait/steal）・
# メモリ（使用中/利用可能/スワップ）・ポート3000の確立済み接続数・cheerstick-server
# （pm2）のCPU/RSS/再起動回数・PostgreSQLの接続数（プロセス数）を、標準出力と
# ログファイルの両方へ1行ずつ出力する。
#
# 読み取り専用（書き込みは自身のログファイルのみ）。追加インストールは不要
# （/proc・free・ss・pm2・ps はt3.microの標準環境にある前提）。Ctrl+Cで停止。
#
# 使い方:
#   ./monitor-server.sh [ログファイルパス]
#   省略時のログファイル: ~/demo-monitor-<YYYYmmdd-HHMMSS>.log

set -u

LOG_FILE="${1:-$HOME/demo-monitor-$(date +%Y%m%d-%H%M%S).log}"
INTERVAL=10
PM2_APP_NAME="cheerstick-server"

echo "[monitor-server] logging to $LOG_FILE (Ctrl+C to stop)"

read_cpu_fields() {
  # /proc/stat 先頭行（全CPU合計）: cpu user nice system idle iowait irq softirq steal guest guest_nice
  # "cpu"ラベルを除いた数値部分（user以降）だけを1行で返す
  awk '/^cpu / { for (i = 2; i <= NF; i++) printf "%s ", $i; print "" }' /proc/stat
}

trap 'echo "[monitor-server] stopped"; exit 0' INT TERM

prev=($(read_cpu_fields))

while true; do
  sleep "$INTERVAL"

  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # --- load average ---
  read -r load1 load5 load15 _ _ < /proc/loadavg

  # --- CPU内訳（前回サンプルとの差分から算出） ---
  curr=($(read_cpu_fields))
  user_d=$((curr[0] - prev[0]))
  sys_d=$((curr[2] - prev[2]))
  iowait_d=$((curr[4] - prev[4]))
  steal_d=$((curr[7] - prev[7]))
  total_d=$(( (curr[0]-prev[0]) + (curr[1]-prev[1]) + (curr[2]-prev[2]) + (curr[3]-prev[3]) \
            + (curr[4]-prev[4]) + (curr[5]-prev[5]) + (curr[6]-prev[6]) + (curr[7]-prev[7]) ))
  prev=("${curr[@]}")

  if [ "$total_d" -gt 0 ]; then
    user_pct=$(awk -v a="$user_d" -v t="$total_d" 'BEGIN{printf "%.1f", a/t*100}')
    sys_pct=$(awk -v a="$sys_d" -v t="$total_d" 'BEGIN{printf "%.1f", a/t*100}')
    iowait_pct=$(awk -v a="$iowait_d" -v t="$total_d" 'BEGIN{printf "%.1f", a/t*100}')
    steal_pct=$(awk -v a="$steal_d" -v t="$total_d" 'BEGIN{printf "%.1f", a/t*100}')
  else
    user_pct="0.0"; sys_pct="0.0"; iowait_pct="0.0"; steal_pct="0.0"
  fi

  # --- メモリ・スワップ ---
  mem_used=$(free -m | awk '/^Mem:/ {print $3}')
  mem_avail=$(free -m | awk '/^Mem:/ {print $7}')
  swap_used=$(free -m | awk '/^Swap:/ {print $3}')

  # --- ポート3000の確立済み接続数（WebSocket） ---
  ws_conns=$(ss -tn state established '( sport = :3000 )' 2>/dev/null | tail -n +2 | wc -l)

  # --- cheerstick-server（pm2） ---
  pm2_json=$(pm2 jlist 2>/dev/null)
  pm2_cpu=$(echo "$pm2_json" | grep -o '"cpu":[0-9.]*' | head -1 | cut -d: -f2)
  pm2_mem_bytes=$(echo "$pm2_json" | grep -o '"memory":[0-9]*' | head -1 | cut -d: -f2)
  pm2_restarts=$(echo "$pm2_json" | grep -o '"restart_time":[0-9]*' | head -1 | cut -d: -f2)
  if [ -n "${pm2_mem_bytes:-}" ]; then
    pm2_rss_mb=$(awk -v b="$pm2_mem_bytes" 'BEGIN{printf "%.1f", b/1024/1024}')
  else
    pm2_rss_mb="NA"
  fi

  # --- PostgreSQL接続数（プロセス数。DBへの接続・クエリはしない） ---
  pg_procs=$(ps -C postgres --no-headers 2>/dev/null | wc -l)

  line="$ts load1=$load1 load5=$load5 load15=$load15 cpu_user=${user_pct}% cpu_sys=${sys_pct}% cpu_iowait=${iowait_pct}% cpu_steal=${steal_pct}% mem_used=${mem_used}MB mem_available=${mem_avail}MB swap_used=${swap_used}MB ws_conns_3000=${ws_conns} pm2_${PM2_APP_NAME}_cpu=${pm2_cpu:-NA}% pm2_${PM2_APP_NAME}_rss=${pm2_rss_mb}MB pm2_${PM2_APP_NAME}_restarts=${pm2_restarts:-NA} pg_processes=${pg_procs}"

  echo "$line" | tee -a "$LOG_FILE"
done
