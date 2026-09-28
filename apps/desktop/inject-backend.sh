#!/usr/bin/env bash
set -euo pipefail

desktop_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$desktop_dir/../.." && pwd)"
platform_name="${BUILD_PLATFORM:?BUILD_PLATFORM is required}"
source_dir="$repo_dir/build-artifacts/$platform_name/backend/main.dist"
target_dir="$desktop_dir/resources-placeholder/backend"

test -d "$source_dir"
stage_dir="$(mktemp -d "$desktop_dir/resources-placeholder/backend.stage.XXXXXX")"
trap 'rm -rf "$stage_dir"' EXIT
cp -R "$source_dir/." "$stage_dir/"
rm -rf "$target_dir"
mv "$stage_dir" "$target_dir"
