#!/usr/bin/env bash
set -euo pipefail

version="${WORKSTEP_ACTION_INPUT:-}"
if [[ -n "$version" ]]; then
  exec ./apps/desktop/package-local-macos.sh "$version"
fi

exec ./apps/desktop/package-local-macos.sh
