#!/bin/sh
set -eu

# The entrypoint and seed live outside HOME, so an empty /root bind mount works.
seed=${WORKSTEP_RUNTIME_SEED_DIR:-/usr/local/share/workstep-runtime}
runtime="$HOME/.workstep/runtime"
mkdir -p "$runtime"

(
    flock -x 9

    # Recover a process interrupted between the two directory renames.
    if [ ! -e "$runtime/base" ] && [ -d "$runtime/.base-previous" ]; then
        mv "$runtime/.base-previous" "$runtime/base"
    fi

    expected=$(cat "$seed/base.sha256")
    installed=$(cat "$runtime/base/.image-sha256" 2>/dev/null || true)
    updated=false
    if [ "$installed" != "$expected" ]; then
        actual=$(sha256sum "$seed/base.tar")
        actual=${actual%% *}
        if [ "$actual" != "$expected" ]; then
            echo 'WorkStep runtime seed checksum mismatch' >&2
            exit 1
        fi

        stage=$(mktemp -d "$runtime/.base-stage.XXXXXX")
        trap 'rm -rf "$stage"' 0
        trap 'exit 1' HUP INT TERM
        tar -xf "$seed/base.tar" -C "$stage"
        test -d "$stage/base/bin"
        printf '%s\n' "$expected" > "$stage/base/.image-sha256"

        rm -rf "$runtime/.base-previous"
        if [ -e "$runtime/base" ]; then
            mv "$runtime/base" "$runtime/.base-previous"
        fi
        mv "$stage/base" "$runtime/base"
        rm -rf "$runtime/.base-previous"
        updated=true
    fi

    # Refresh Volta's own executables without replacing user-installed tools.
    if [ -d "$runtime/base/volta/bin" ] && { [ "$updated" = true ] || [ ! -d "$runtime/volta/bin" ]; }; then
        mkdir -p "$runtime/volta/bin"
        cp -a "$runtime/base/volta/bin/." "$runtime/volta/bin/"
    fi
) 9> "$runtime/.bootstrap.lock"

exec "$@"
