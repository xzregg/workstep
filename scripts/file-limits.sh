# Sourced by service launchers; children inherit this soft descriptor limit.
workstep_configure_file_limit() {
    local requested="${WORKSTEP_NOFILE_LIMIT:-4096}"
    if [[ ! "$requested" =~ ^[1-9][0-9]{0,8}$ ]]; then
        echo "WORKSTEP_NOFILE_LIMIT 必须为 1–999999999 的整数" >&2
        return 1
    fi
    local current hard target
    current=$(ulimit -Sn)
    hard=$(ulimit -Hn)
    target=$requested
    if [[ "$hard" != unlimited ]] && (( target > hard )); then
        target=$hard
    fi
    if [[ "$current" != unlimited ]] && (( current < target )); then
        if ! ulimit -Sn "$target"; then
            echo "[workstep] 无法提高文件描述符上限，保留 $current" >&2
        fi
    fi
    echo "[workstep] 文件描述符软上限：$(ulimit -Sn)（请求 ${requested}，硬上限 ${hard}）"
}
workstep_configure_file_limit || return 1
