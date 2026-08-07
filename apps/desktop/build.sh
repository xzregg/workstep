#!/usr/bin/env bash
# WorkStep Desktop — macOS / Linux build script
# Usage: ./build.sh
# Output: apps/desktop/dist/WorkStep-macOS-<version>.zip (or -Linux-<version>.zip)
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="$DESKTOP_DIR/../daemon"
WEB_DIR="$DESKTOP_DIR/../web"

VERSION="$(grep -m1 '^version' "$DAEMON_DIR/pyproject.toml" | sed -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/')"

log() { echo -e "\033[34m[desktop]\033[0m $1"; }
ok()  { echo -e "\033[32m[desktop]\033[0m $1"; }

# 1. Build the web frontend (compiled React bundle that ships inside the app)
log "Building web frontend (apps/web)..."
(cd "$WEB_DIR" && npm ci && npm run build)
ok "Web build done."

# 2. Install build dependencies (pywebview / pyinstaller via the desktop group)
log "Syncing daemon deps (desktop group)..."
(cd "$DAEMON_DIR" && uv sync --group desktop)
ok "Deps synced."

# 3. Bundle the daemon + web build + data with PyInstaller
log "Running PyInstaller (this bundles the ~300MB Codex CLI runtime)..."
(cd "$DAEMON_DIR" && uv run pyinstaller "$DESKTOP_DIR/workstep_desktop.spec" \
    --noconfirm --clean \
    --distpath "$DESKTOP_DIR/dist" \
    --workpath "$DESKTOP_DIR/build")
ok "PyInstaller done."

# 4. Package a portable archive
cd "$DESKTOP_DIR/dist"
if [ -d "WorkStep.app" ]; then
    OUT="WorkStep-macOS-$VERSION.zip"
    log "Packaging WorkStep.app -> $OUT"
    rm -f "$OUT"
    ditto -c -k --keepParent "WorkStep.app" "$OUT"
else
    OUT="WorkStep-Linux-$VERSION.zip"
    log "Packaging WorkStep/ -> $OUT"
    rm -f "$OUT"
    ditto -c -k --keepParent "WorkStep" "$OUT" 2>/dev/null || zip -rq "$OUT" "WorkStep"
fi
ok "Done: $DESKTOP_DIR/dist/$OUT"
