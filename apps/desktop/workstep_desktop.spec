# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the WorkStep desktop app (shared macOS/Windows).

Build with:
    cd apps/daemon && uv run pyinstaller ../desktop/workstep_desktop.spec \
        --noconfirm --clean --distpath ../desktop/dist --workpath ../desktop/build
"""

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

# SPECPATH is injected by PyInstaller as the directory containing this spec.
desktop_dir = Path(SPECPATH)
apps_dir = desktop_dir.parent  # <repo>/apps
daemon_dir = apps_dir / "daemon"
web_dist = apps_dir / "web" / "dist"

# --- bundled data ---
datas = [
    # Compiled React build, served by the daemon as the web UI.
    (str(web_dist), "web_dist"),
    # Shipped templates / output-types seed data (paths are resolved from
    # __file__ inside the bundle, so they land under _MEIPASS/data).
    (str(daemon_dir / "data"), "data"),
]

# --- engine SDKs are imported lazily at runtime; collect them explicitly ---
# openai_codex + codex_cli_bin bring the bundled Codex CLI runtime (~300MB);
# claude_agent_sdk / pydantic_ai are pure SDK packages. Qoder remains a
# user-installed optional integration because it has separate service terms.
hiddenimports: list[str] = []
binaries: list = []
for pkg in ("openai_codex", "codex_cli_bin", "claude_agent_sdk", "pydantic_ai"):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

# uvicorn[standard] + fastapi dynamic imports
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("fastapi")

a = Analysis(
    [str(desktop_dir / "desktop_main.py")],
    pathex=[str(daemon_dir)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe_kwargs = dict(
    name="WorkStep",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
)
if sys.platform == "win32":
    ico = desktop_dir / "assets" / "icon.ico"
    if ico.exists():
        exe_kwargs["icon"] = str(ico)

exe = EXE(pyz, a.scripts, [], exclude_binaries=True, **exe_kwargs)

coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="WorkStep")

if sys.platform == "darwin":
    bundle_kwargs = dict(
        name="WorkStep.app",
        bundle_identifier="com.workstep.desktop",
        info_plist={
            "NSHighResolutionCapable": True,
            "CFBundleDisplayName": "WorkStep",
            "NSHumanReadableCopyright": "WorkStep",
            "CFBundleURLTypes": [{
                "CFBundleURLName": "com.workstep.desktop",
                "CFBundleURLSchemes": ["workstep"],
            }],
        },
    )
    icns = desktop_dir / "assets" / "icon.icns"
    if icns.exists():
        bundle_kwargs["icon"] = str(icns)
    app = BUNDLE(coll, **bundle_kwargs)
