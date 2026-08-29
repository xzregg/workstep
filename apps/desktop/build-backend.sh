#!/usr/bin/env bash
set -euo pipefail

desktop_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
apps_dir="$(cd "$desktop_dir/.." && pwd)"
repo_dir="$(cd "$apps_dir/.." && pwd)"
daemon_dir="$apps_dir/daemon"
web_dir="$apps_dir/web"
platform_name="${BUILD_PLATFORM:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
case "$platform_name" in
  darwin|mac|macos) platform_name="mac" ;;
  linux) platform_name="linux" ;;
  *) echo "Unsupported build platform: $platform_name" >&2; exit 1 ;;
esac

venv_dir="$desktop_dir/.nuitka-venv"
python_bin="$venv_dir/bin/python"
output_dir="$repo_dir/build-artifacts/$platform_name/backend"
stage_dir="$(mktemp -d)"
trap 'rm -rf "$stage_dir"' EXIT

python3 -m venv "$venv_dir"
uv pip install --python "$python_bin" \
  -r "$desktop_dir/backend/requirements-prod.txt" \
  "Nuitka==4.1.3"

cp "$daemon_dir/main.py" "$stage_dir/daemon_entry.py"
PYTHONPATH="$stage_dir:$daemon_dir" "$python_bin" -m nuitka \
  "$desktop_dir/backend/main.py" \
  --standalone \
  --assume-yes-for-downloads \
  --follow-imports \
  --include-module=daemon_entry \
  --include-package=api \
  --include-package=agent_assistants \
  --include-package=engines \
  --include-package=models \
  --include-package=schemas \
  --include-package=services \
  --include-package=streaming \
  --include-package=uvicorn \
  --include-package=fastapi \
  --include-package=openai_codex \
  --include-package=codex_cli_bin \
  --include-package=claude_agent_sdk \
  --include-package=pydantic_ai \
  --include-package=pydantic_ai_harness \
  --include-package-data=codex_cli_bin \
  --include-package-data=claude_agent_sdk \
  --include-data-dir="$daemon_dir/data=data" \
  --output-dir="$output_dir"

cp -R "$web_dir/dist" "$output_dir/main.dist/web_dist"
