#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_dir="$repo_dir/apps/web"
desktop_build="$repo_dir/apps/desktop/build-backend.sh"
build_web=""

select_yarn() {
  if command -v corepack >/dev/null 2>&1; then
    YARN_COMMAND=(corepack yarn)
  elif command -v yarn >/dev/null 2>&1; then
    YARN_COMMAND=(yarn)
    echo "未找到 Corepack，使用现有 Yarn $(yarn --version)"
  else
    echo "需要 Yarn；请安装 Yarn，或使用带 Corepack 的 Node.js 20/22" >&2
    exit 1
  fi
}

run_yarn() {
  "${YARN_COMMAND[@]}" "$@"
}

usage() {
  cat <<'EOF'
用法: ./build.sh [--with-web|--no-web]

  --with-web  先构建 apps/web/dist，再构建桌面后端包
  --no-web    跳过前端构建，复用已有 apps/web/dist

不带参数时进入交互确认。
EOF
}

for option in "$@"; do
  case "$option" in
    --with-web)
      build_web=1
      ;;
    --no-web)
      build_web=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $option" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$build_web" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "是否构建 Web dist? [Y/n] " answer
    case "$answer" in
      n|N|no|NO)
        build_web=0
        ;;
      *)
        build_web=1
        ;;
    esac
  else
    build_web=1
  fi
fi

if [[ "$build_web" == "1" ]]; then
  select_yarn
  echo "构建 Web dist..."
  cd "$web_dir"
  if [[ ! -x node_modules/.bin/vite ]]; then
    run_yarn install --frozen-lockfile
  fi
  run_yarn build
  test -f "$web_dir/dist/index.html"
else
  test -f "$web_dir/dist/index.html" || {
    echo "未找到 apps/web/dist/index.html，请先运行 ./build.sh --with-web" >&2
    exit 1
  }
  echo "复用已有 Web dist"
fi

echo "构建桌面后端包..."
cd "$repo_dir"
"$desktop_build"
