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

output_root="$repo_dir/build-artifacts/$platform_name/backend"
output_dir="$output_root/main.dist"
stage_dir="$(mktemp -d)"
python_install_dir="$stage_dir/python-install"
python_version="3.12.13"
trap 'rm -rf "$stage_dir"' EXIT

# Keep the desktop daemon self-contained but writable: optional Python SDK
# engines are installed into this bundled runtime only after the user clicks.
uv python install --managed-python --no-bin --install-dir "$python_install_dir" "$python_version"
python_root="$(find "$python_install_dir" -mindepth 1 -maxdepth 1 -type d -name 'cpython-3.12*' -print -quit)"
test -n "$python_root"
python_bin="$(find "$python_root/bin" -maxdepth 1 -type f -name 'python3.12' -print -quit)"
test -x "$python_bin"
uv pip install --break-system-packages --python "$python_bin" \
  --require-hashes \
  -r "$desktop_dir/backend/requirements-prod.txt" \
  -r "$desktop_dir/backend/requirements-gateway.txt" \
  -r "$desktop_dir/backend/requirements-bootstrap.txt"

rm -rf "$output_dir"
mkdir -p "$output_dir/app/daemon"
cp -R "$python_root" "$output_dir/python"
cp "$desktop_dir/backend/main.py" "$desktop_dir/backend/server.py" "$output_dir/app/"
cp "$daemon_dir/__init__.py" "$daemon_dir/cli.py" "$daemon_dir/main.py" "$daemon_dir/settings.py" "$daemon_dir/version.py" "$output_dir/app/daemon/"
cp -R "$repo_dir/packages/gateway-protocol/src/workstep_gateway_protocol" "$output_dir/app/daemon/"
for runtime_dir in agent_assistants api data engines models schemas services static streaming; do
  cp -R "$daemon_dir/$runtime_dir" "$output_dir/app/daemon/$runtime_dir"
done
cp -R "$web_dir/dist" "$output_dir/web_dist"

release_version="${WORKSTEP_BUILD_VERSION:-0.1.0}"
release_version="${release_version#v}"
mkdir -p "$output_dir/legal"
cp "$repo_dir/LICENSE" "$repo_dir/NOTICE" "$repo_dir/THIRD_PARTY_NOTICES.md" "$output_dir/legal/"
python "$repo_dir/scripts/generate_release_sbom.py" \
  --version "$release_version" \
  --output "$output_dir/legal/sbom.cdx.json"
