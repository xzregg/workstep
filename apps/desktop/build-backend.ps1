$ErrorActionPreference = "Stop"

$DesktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppsDir = Split-Path -Parent $DesktopDir
$RepoDir = Split-Path -Parent $AppsDir
$DaemonDir = Join-Path $AppsDir "daemon"
$WebDir = Join-Path $AppsDir "web"
$VenvDir = Join-Path $DesktopDir ".nuitka-venv"
$Python = Join-Path $VenvDir "Scripts/python.exe"
$OutputDir = Join-Path $RepoDir "build-artifacts/win/backend"
$StageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("workstep-nuitka-" + [guid]::NewGuid())

try {
  python -m venv $VenvDir
  uv pip install --python $Python -r (Join-Path $DesktopDir "backend/requirements-prod.txt") "Nuitka==4.1.3"
  New-Item -ItemType Directory -Path $StageDir | Out-Null
  Copy-Item (Join-Path $DaemonDir "main.py") (Join-Path $StageDir "daemon_entry.py")
  $env:PYTHONPATH = "$StageDir;$DaemonDir"
  & $Python -m nuitka `
    (Join-Path $DesktopDir "backend/main.py") `
    --standalone `
    --assume-yes-for-downloads `
    --follow-imports `
    --windows-console-mode=attach `
    --include-module=daemon_entry `
    --include-package=api `
    --include-package=agent_assistants `
    --include-package=engines `
    --include-package=models `
    --include-package=schemas `
    --include-package=services `
    --include-package=streaming `
    --include-package=uvicorn `
    --include-package=fastapi `
    --include-package=openai_codex `
    --include-package=codex_cli_bin `
    --include-package=claude_agent_sdk `
    --include-package=pydantic_ai `
    --include-package=pydantic_ai_harness `
    --include-package-data=codex_cli_bin `
    --include-package-data=claude_agent_sdk `
    "--include-data-dir=$DaemonDir/data=data" `
    "--output-dir=$OutputDir"
  Copy-Item (Join-Path $WebDir "dist") (Join-Path $OutputDir "main.dist/web_dist") -Recurse
} finally {
  if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
}
