$ErrorActionPreference = "Stop"

$DesktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppsDir = Split-Path -Parent $DesktopDir
$RepoDir = Split-Path -Parent $AppsDir
$DaemonDir = Join-Path $AppsDir "daemon"
$WebDir = Join-Path $AppsDir "web"
$OutputRoot = Join-Path $RepoDir "build-artifacts/win/backend"
$OutputDir = Join-Path $OutputRoot "main.dist"
$StageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("workstep-python-" + [guid]::NewGuid())
$PythonInstallDir = Join-Path $StageDir "python-install"
$PythonVersion = "3.12.13"

try {
  # Keep the desktop daemon self-contained but writable: optional Python SDK
  # engines are installed into this bundled runtime only after the user clicks.
  uv python install --managed-python --no-bin --install-dir $PythonInstallDir $PythonVersion
  $PythonRoot = Get-ChildItem $PythonInstallDir -Directory -Filter "cpython-3.12*" | Select-Object -First 1
  if (-not $PythonRoot) { throw "uv-managed Python installation was not found" }
  $Python = Join-Path $PythonRoot.FullName "python.exe"
  uv pip install --break-system-packages --require-hashes --python $Python `
    -r (Join-Path $DesktopDir "backend/requirements-prod.txt") `
    -r (Join-Path $DesktopDir "backend/requirements-bootstrap.txt")

  if (Test-Path $OutputDir) { Remove-Item $OutputDir -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $OutputDir "app/daemon") -Force | Out-Null
  Copy-Item $PythonRoot.FullName (Join-Path $OutputDir "python") -Recurse
  Copy-Item (Join-Path $DesktopDir "backend/main.py") (Join-Path $OutputDir "app/main.py")
  Copy-Item (Join-Path $DesktopDir "backend/server.py") (Join-Path $OutputDir "app/server.py")
  foreach ($File in @("__init__.py", "main.py", "settings.py", "version.py")) {
    Copy-Item (Join-Path $DaemonDir $File) (Join-Path $OutputDir "app/daemon/$File")
  }
  foreach ($RuntimeDir in @("agent_assistants", "api", "data", "engines", "models", "schemas", "services", "static", "streaming")) {
    Copy-Item (Join-Path $DaemonDir $RuntimeDir) (Join-Path $OutputDir "app/daemon/$RuntimeDir") -Recurse
  }
  Copy-Item (Join-Path $WebDir "dist") (Join-Path $OutputDir "web_dist") -Recurse
  $ReleaseVersion = if ($env:WORKSTEP_BUILD_VERSION) { $env:WORKSTEP_BUILD_VERSION.TrimStart("v") } else { "0.1.0" }
  $LegalDir = Join-Path $OutputDir "legal"
  New-Item -ItemType Directory -Path $LegalDir -Force | Out-Null
  Copy-Item (Join-Path $RepoDir "LICENSE") $LegalDir
  Copy-Item (Join-Path $RepoDir "NOTICE") $LegalDir
  Copy-Item (Join-Path $RepoDir "THIRD_PARTY_NOTICES.md") $LegalDir
  python (Join-Path $RepoDir "scripts/generate_release_sbom.py") `
    --version $ReleaseVersion `
    --output (Join-Path $LegalDir "sbom.cdx.json")
} finally {
  if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
}
