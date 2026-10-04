$ErrorActionPreference = "Stop"

$DesktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent (Split-Path -Parent $DesktopDir)
$SourceDir = Join-Path $RepoDir "build-artifacts/win/backend/main.dist"
$TargetDir = Join-Path $DesktopDir "resources-placeholder/backend"

if (-not (Test-Path $SourceDir)) { throw "Backend artifact not found: $SourceDir" }
$StageDir = Join-Path $DesktopDir ("resources-placeholder/backend.stage." + [guid]::NewGuid())
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
try {
  Copy-Item (Join-Path $SourceDir "*") $StageDir -Recurse -Force
  if (Test-Path $TargetDir) { Remove-Item $TargetDir -Recurse -Force }
  Move-Item $StageDir $TargetDir
} finally {
  if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
}
