# WorkStep Desktop — Windows build script
# Usage: .\build.ps1
# Output: apps\desktop\dist\WorkStep-Windows-<version>.zip
$ErrorActionPreference = "Stop"

$DesktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $DesktopDir
$DaemonDir = Join-Path $RootDir "daemon"
$WebDir = Join-Path $RootDir "web"

$VersionMatch = Select-String -Path (Join-Path $DaemonDir "pyproject.toml") -Pattern '^version\s*=\s*"([^"]+)"'
$Version = $VersionMatch.Matches.Groups[1].Value

function Log([string]$Msg) { Write-Host "[desktop] $Msg" -ForegroundColor Cyan }
function OK([string]$Msg)  { Write-Host "[desktop] $Msg" -ForegroundColor Green }

# 1. Build the web frontend (compiled React bundle that ships inside the app)
Log "Building web frontend (apps\web)..."
Push-Location $WebDir
npm ci
npm run build
Pop-Location
OK "Web build done."

# 2. Install build dependencies (pywebview / pyinstaller via the desktop group)
Log "Syncing daemon deps (desktop group)..."
Push-Location $DaemonDir
uv sync --group desktop
Pop-Location
OK "Deps synced."

# 3. Bundle the daemon + web build + data with PyInstaller
Log "Running PyInstaller (this bundles the ~300MB Codex CLI runtime)..."
Push-Location $DaemonDir
uv run pyinstaller (Join-Path $DesktopDir "workstep_desktop.spec") --noconfirm --clean --distpath (Join-Path $DesktopDir "dist") --workpath (Join-Path $DesktopDir "build")
Pop-Location
OK "PyInstaller done."

# 4. Package a portable archive
$DistDir = Join-Path $DesktopDir "dist"
$Out = Join-Path $DistDir "WorkStep-Windows-$Version.zip"
Log "Packaging dist\WorkStep -> $Out"
Remove-Item -Force $Out -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $DistDir "WorkStep") -DestinationPath $Out -CompressionLevel Optimal
OK "Done: $Out"
