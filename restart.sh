#!/bin/bash
# WorkStep — 重启脚本
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/stop.sh" "$@"
sleep 1
"$SCRIPT_DIR/start.sh" "$@"
