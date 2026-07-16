#!/bin/bash
# WorkStep — 停止脚本
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"
PORT=${1:-8765}

stop_service() {
    local pid_file=$1
    local port=$2
    if [ -f "$pid_file" ]; then
        local pid
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            sleep 0.5
            kill -9 "$pid" 2>/dev/null || true
            echo -e "${GREEN}[stopped]${NC} PID $pid (port $port)"
        else
            echo -e "${RED}[stale]${NC} PID $pid not running"
        fi
        rm -f "$pid_file"
    fi
    # 按端口兜底
    local pids
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill -9 2>/dev/null || true
        echo -e "${GREEN}[stopped]${NC} port $port processes"
    fi
}

stop_service "$PID_DIR/daemon.pid" "$PORT"
stop_service "$PID_DIR/web.pid" "5173"

echo -e "${GREEN}WorkStep 已停止${NC}"
