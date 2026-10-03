#!/usr/bin/env bash
# ./start-gateway.sh [port=8700] [dev|prod]
set -euo pipefail
gateway_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gateway_port="${1:-8700}"
gateway_mode="${2:-dev}"
[[ "$gateway_port" =~ ^[0-9]+$ ]] && (( gateway_port > 0 && gateway_port <= 65535 )) || { echo '端口必须为 1–65535' >&2; exit 1; }
[[ "$gateway_mode" == dev || "$gateway_mode" == prod ]] || { echo '模式必须为 dev 或 prod' >&2; exit 1; }
command -v uv >/dev/null
command -v yarn >/dev/null
if [[ -f "$gateway_root/.env" ]]; then
  set -a
  source "$gateway_root/.env"
  set +a
fi
export WORKSTEP_GATEWAY_PORT="$gateway_port"
export WORKSTEP_GATEWAY_PUBLIC_ORIGIN="${WORKSTEP_GATEWAY_PUBLIC_ORIGIN:-http://localhost:$gateway_port}"
export WORKSTEP_GATEWAY_WEB_DIST="${WORKSTEP_GATEWAY_WEB_DIST:-$gateway_root/apps/gateway-web/dist}"
export WORKSTEP_GATEWAY_WORKSPACE_WEB_DIST="${WORKSTEP_GATEWAY_WORKSPACE_WEB_DIST:-$gateway_root/apps/web/dist-gateway-share}"
[[ -d "$gateway_root/apps/gateway/.venv" ]] || uv sync --project "$gateway_root/apps/gateway" --dev
for gateway_frontend in gateway-web web; do
  (
    cd "$gateway_root/apps/$gateway_frontend"
    [[ -d node_modules ]] || yarn install --frozen-lockfile
    if [[ "$gateway_frontend" == web ]]; then yarn build:gateway-share; else yarn build; fi
  )
done
echo "WORKSTEP 平台 → ${WORKSTEP_GATEWAY_PUBLIC_ORIGIN}（Ctrl+C 停止）"
cd "$gateway_root/apps/gateway"
if [[ "$gateway_mode" == dev ]]; then
  exec uv run --no-sync uvicorn main:app --host 127.0.0.1 --port "$gateway_port" --reload
fi
exec uv run --no-sync uvicorn main:app --host 127.0.0.1 --port "$gateway_port"
