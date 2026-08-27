#!/usr/bin/env bash
# WorkStep Desktop — macOS / Linux build script
# Usage: ./build.sh
# Output names are stable so GitHub's latest-release download URLs keep working.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="$DESKTOP_DIR/../daemon"
WEB_DIR="$DESKTOP_DIR/../web"

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
    ARCH="${WORKSTEP_ARCH:-$(uname -m)}"
    [ "$ARCH" = "x86_64" ] && ARCH="x64"
    OUT="WorkStep-macos-$ARCH.dmg"
    log "Packaging WorkStep.app -> $OUT"
    rm -f "$OUT"
    hdiutil create -volname WorkStep -srcfolder "WorkStep.app" -ov -format UDZO "$OUT"
else
    OUT="WorkStep-linux-x64.AppImage"
    log "Packaging WorkStep/ -> $OUT"
    rm -f "$OUT"
    APPDIR="$DESKTOP_DIR/build/WorkStep.AppDir"
    rm -rf "$APPDIR"
    mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications"
    cp -R WorkStep/. "$APPDIR/usr/bin/"
    cp "$DESKTOP_DIR/assets/icon.png" "$APPDIR/workstep.png"
    cp "$DESKTOP_DIR/workstep.desktop" "$APPDIR/workstep.desktop"
    cp "$DESKTOP_DIR/AppRun" "$APPDIR/AppRun"
    chmod +x "$APPDIR/AppRun"
    appimagetool "$APPDIR" "$OUT"
fi
ok "Done: $DESKTOP_DIR/dist/$OUT"
