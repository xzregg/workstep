$ErrorActionPreference = "Stop"

$DesktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent (Split-Path -Parent $DesktopDir)
$SourceDir = Join-Path $RepoDir "build-artifacts/win/backend/main.dist"
$TargetDir = Join-Path $DesktopDir "resources-placeholder/backend"

if (-not (Test-Path $SourceDir)) { throw "Backend artifact not found: $SourceDir" }
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
Copy-Item (Join-Path $SourceDir "*") $TargetDir -Recurse -Force
