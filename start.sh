#!/bin/bash
# WorkStep — 启动脚本（前后端分离）
# 用法: ./start.sh [backend_port] [dev|prod]
#   dev  (默认): 启动 daemon + vite dev server（HMR）
#   prod: 启动 daemon + serve 前端 build
set -e

# === 颜色 ===
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# === 配置 ===
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="$SCRIPT_DIR/apps/daemon"
WEB_DIR="$SCRIPT_DIR/apps/web"
LANDING_DIR="$SCRIPT_DIR/apps/landing"
DEFAULT_PORT=8765
PORT=${1:-$DEFAULT_PORT}
MODE=${2:-dev}
PID_DIR="$SCRIPT_DIR/.pids"
LOG_DIR="$SCRIPT_DIR/logs"

# 加载本地环境变量（.env 已加入 .gitignore，不提交密钥）
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# === 清理环境变量 ===
unset CLAUDECODE

# === 目录准备 ===
mkdir -p "$PID_DIR" "$LOG_DIR"

# === 工具函数 ===
log()  { echo -e "${BLUE}[workstep]${NC} $1"; }
ok()   { echo -e "${GREEN}[  ok  ]${NC} $1"; }
warn() { echo -e "${YELLOW}[ warn ]${NC} $1"; }
fail() { echo -e "${RED}[ fail ]${NC} $1"; exit 1; }

select_yarn() {
    if command -v corepack >/dev/null 2>&1; then
        YARN_COMMAND=(corepack yarn)
    elif command -v yarn >/dev/null 2>&1; then
        YARN_COMMAND=(yarn)
        warn "未找到 Corepack，使用现有 Yarn $(yarn --version)"
    else
        fail "需要 Yarn；请安装 Yarn，或使用带 Corepack 的 Node.js 20/22"
    fi
}

run_yarn() {
    "${YARN_COMMAND[@]}" "$@"
}

check_port() {
    if lsof -ti:"$1" >/dev/null 2>&1; then
        return 0  # 端口被占
    fi
    return 1  # 端口空闲
}

stop_service() {
    local pid_file=$1
    if [ -f "$pid_file" ]; then
        local pid
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            sleep 0.5
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$pid_file"
    fi
}

wait_ready() {
    local url=$1
    local max_wait=${2:-10}
    local waited=0
    while [ $waited -lt $max_wait ]; do
        if curl -s "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.5
        waited=$((waited + 1))
    done
    return 1
}

# === 预检查 ===
if check_port "$PORT"; then
    fail "端口 $PORT 已被其他进程占用，请先停止该进程或传入其他端口"
fi

# 检查依赖
command -v uv >/dev/null 2>&1 || fail "需要 uv (curl -LsSf https://astral.sh/uv/install.sh | sh)"
command -v node >/dev/null 2>&1 || fail "需要 Node.js 20+"
select_yarn

# === 构建官网 ===
# Daemon 在 "/landing" 托管官网，dev/prod 启动都需使用对应资源基路径。
log "构建官网 landing..."
cd "$LANDING_DIR"
if [ ! -d "node_modules" ] || [ ! -f "node_modules/.bin/vite" ]; then
    NODE_ENV=development run_yarn install --frozen-lockfile 2>&1 | tail -3
fi
LANDING_BASE=/landing/ run_yarn build
cd "$SCRIPT_DIR"
ok "官网已构建 → Daemon serve /landing"

# === 清理函数 ===
cleanup() {
    echo ""
    log "正在停止..."
    stop_service "$PID_DIR/daemon.pid"
    stop_service "$PID_DIR/web.pid"
    ok "已停止"
    exit 0
}
trap cleanup SIGINT SIGTERM

# === 启动后端 ===
log "启动 Daemon (port=$PORT, mode=$MODE)..."
cd "$DAEMON_DIR"

# 安装依赖
if [ ! -d ".venv" ]; then
    log "安装后端依赖..."
    NODE_ENV=development uv sync --group dev 2>&1 | tail -3
fi

# 引擎 SDK 由设置页按需安装；启动时同步依赖会卸载这些额外包。
nohup env WORKSTEP_ENV="$MODE" uv run --no-sync uvicorn main:app \
    --host 0.0.0.0 \
    --port "$PORT" \
    > "$LOG_DIR/daemon.log" 2>&1 &
echo $! > "$PID_DIR/daemon.pid"
cd "$SCRIPT_DIR"

# 等待后端就绪
if wait_ready "http://localhost:$PORT/api/health" 15; then
    ok "Daemon 已就绪 → http://localhost:$PORT"
else
    fail "Daemon 启动超时，查看日志: $LOG_DIR/daemon.log"
fi

# === 启动前端 ===
if [ "$MODE" = "dev" ]; then
    log "启动前端 Dev Server..."
    cd "$WEB_DIR"

    # 安装依赖
    if [ ! -d "node_modules" ] || [ ! -f "node_modules/.bin/vite" ]; then
        log "安装前端依赖..."
        NODE_ENV=development run_yarn install --frozen-lockfile 2>&1 | tail -3
    fi

    nohup "${YARN_COMMAND[@]}" vite --port 5173 \
        > "$LOG_DIR/web.log" 2>&1 &
    echo $! > "$PID_DIR/web.pid"
    cd "$SCRIPT_DIR"

    sleep 2
    ok "前端 Dev Server → http://localhost:5173 (HMR)"
    echo ""
    echo -e "  ${GREEN}前端:${NC}  http://localhost:5173"
    echo -e "  ${GREEN}后端:${NC}  http://localhost:$PORT"
    echo -e "  ${GREEN}API文档:${NC} http://localhost:$PORT/docs"
    echo -e "  ${BLUE}日志:${NC}  $LOG_DIR/"
    echo ""
    echo "  Ctrl+C 停止所有服务"
    echo ""
    tail -f "$LOG_DIR/daemon.log" "$LOG_DIR/web.log"
else
    # 生产模式: build 前端(web) → Daemon serve
    # 官网托管在 "/landing"，Web 应用仍占据 home "/"
    log "构建前端 web..."
    cd "$WEB_DIR"
    if [ ! -d "node_modules" ] || [ ! -f "node_modules/.bin/vite" ]; then
        NODE_ENV=development run_yarn install --frozen-lockfile 2>&1 | tail -3
    fi
    NODE_ENV=development run_yarn build
    cd "$SCRIPT_DIR"
    ok "前端已构建 → Daemon serve home /"
    echo ""
    echo -e "  ${GREEN}官网:${NC}  http://localhost:$PORT/landing"
    echo -e "  ${GREEN}应用:${NC}  http://localhost:$PORT/"
    echo -e "  ${GREEN}API文档:${NC} http://localhost:$PORT/docs"
    echo -e "  ${BLUE}日志:${NC}  $LOG_DIR/"
    echo ""
    echo "  Ctrl+C 停止服务"
    echo ""
    tail -f "$LOG_DIR/daemon.log"
fi
