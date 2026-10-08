# ============================================================
# 阶段 1：前端构建（web + landing）
# 完整 node:24-bookworm 提供 yarn（corepack）与编译工具，产物仅拷贝进最终镜像
# ============================================================
FROM --platform=$BUILDPLATFORM node:24-bookworm AS web-build

WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/yarn.lock ./
RUN npm config set registry https://registry.npmjs.org \
    && corepack enable && corepack prepare yarn@1.22.22 --activate \
    && yarn config set registry https://registry.npmjs.org \
    && yarn install --frozen-lockfile
COPY apps/web ./
RUN yarn build

WORKDIR /app/apps/landing
COPY apps/landing/package.json apps/landing/yarn.lock ./
RUN npm config set registry https://registry.npmjs.org \
    && corepack enable && corepack prepare yarn@1.22.22 --activate \
    && yarn config set registry https://registry.npmjs.org \
    && yarn install --frozen-lockfile
COPY apps/landing ./
# 官网以 /landing 子路径托管（与 start.sh 生产模式一致），否则资源路径错误
RUN LANDING_BASE=/landing/ yarn build

# Git 2.48+ is required for portable worktree links across container and host paths.
FROM node:24-bookworm-slim AS git-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl build-essential libcurl4-openssl-dev libssl-dev zlib1g-dev libexpat1-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://www.kernel.org/pub/software/scm/git/git-2.50.1.tar.xz -o /tmp/git.tar.xz \
    && echo '7e3e6c36decbd8f1eedd14d42db6674be03671c2204864befa2a41756c5c8fc4  /tmp/git.tar.xz' | sha256sum -c - \
    && tar -xf /tmp/git.tar.xz -C /tmp \
    && cd /tmp/git-2.50.1 \
    && make prefix=/root/.workstep/runtime/base/git NO_GETTEXT=YesPlease NO_TCLTK=YesPlease -j"$(nproc)" all \
    && make prefix=/root/.workstep/runtime/base/git NO_GETTEXT=YesPlease NO_TCLTK=YesPlease install

# ============================================================
# 阶段 2：运行时镜像（最小化）
# - 基础镜像 node:24-bookworm-slim（Node 24 + npm，约 1/5 体积）
# - 最小系统依赖：git / curl / ca-certificates / jq（引擎安装与 JSON 处理）
# - Python 3.14：由 uv 按 UV_PYTHON 自动下载 standalone 解释器（无需系统 python）
# - 依赖缓存与字节码在构建后立即清理，尽量减小镜像体积
# ============================================================
FROM node:24-bookworm-slim

# 最小系统依赖（git/curl 供应用内安装 LLM 引擎使用，jq 供 JSON 处理）
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git curl jq \
    && rm -rf /var/lib/apt/lists/*
COPY --from=git-build /root/.workstep/runtime/base/git /root/.workstep/runtime/base/git

# Keep the managed runtime under HOME; /usr/local only supplies the image seed.
ENV HOME=/root \
    UV_INSTALL_DIR=/root/.workstep/runtime/base/bin \
    UV_PYTHON_INSTALL_DIR=/root/.workstep/runtime/base/python \
    UV_NO_MODIFY_PATH=1 \
    UV_PYTHON=3.14 \
    UV_CACHE_DIR=/root/.cache/uv \
    UV_LINK_MODE=copy \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_CACHE=/root/.npm \
    NPM_CONFIG_PREFIX=/root/.workstep/runtime/npm \
    WORKSTEP_ENGINE_PACKAGE_DIR=/root/.workstep/runtime/python-packages \
    VOLTA_HOME=/root/.workstep/runtime/volta \
    PATH="/app/apps/daemon/.venv/bin:/root/.workstep/runtime/npm/bin:/root/.workstep/runtime/base/bin:/root/.workstep/runtime/base/git/bin:/root/.workstep/runtime/volta/bin:${PATH}"

RUN mkdir -p /root/.workstep/runtime/base/bin /root/.workstep/runtime/base/lib \
    && cp /usr/local/bin/node /root/.workstep/runtime/base/bin/node \
    && cp -a /usr/local/lib/node_modules /root/.workstep/runtime/base/lib/ \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /root/.workstep/runtime/base/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /root/.workstep/runtime/base/bin/npx

# Seed Volta's binaries separately from its persistent downloads/configuration.
RUN curl -fsSL https://get.volta.sh | VOLTA_HOME=/root/.workstep/runtime/base/volta bash -s -- --skip-setup \
    && mkdir -p "$VOLTA_HOME/bin" \
    && cp -a /root/.workstep/runtime/base/volta/bin/. "$VOLTA_HOME/bin/" \
    && volta --version

RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# 引擎按需安装环境与 JSON 工具自检（Node / npm / Volta / uv / git / curl / jq）
RUN node --version && npm --version && volta --version && uv --version \
    && git --version && jq --version && curl --version | head -1

# 后端依赖（uv.lock 已入库；固定 Python 3.14）
# daemon 经本地 path 依赖 packages/gateway-protocol（editable），
# 先 COPY 进去否则 uv sync 报 Distribution not found；editable 安装指向
# 该目录，运行时也要保留。
WORKDIR /app/apps/daemon
COPY apps/daemon/pyproject.toml apps/daemon/uv.lock apps/daemon/.python-version ./
COPY packages/gateway-protocol /app/packages/gateway-protocol
RUN uv sync --no-dev --frozen \
    && uv pip install --python .venv/bin/python pip \
    && rm -rf /root/.cache/uv

RUN command -v python && python --version \
    && command -v node && node --version \
    && command -v npm && npm --version \
    && command -v volta && volta --version

# 后端源码（清理字节码缓存）
COPY apps/daemon ./
RUN find /app -name '__pycache__' -type d -prune -exec rm -rf {} + \
    && rm -rf /root/.cache

# 前端构建产物（settings.py 中 web_dist=../web/dist、landing_dist=../landing/dist）
COPY --from=web-build /app/apps/web/dist ../web/dist
COPY --from=web-build /app/apps/landing/dist ../landing/dist

# An immutable seed remains visible when HOME is bind-mounted. First startup
# installs it offline; a new image refreshes only base, retaining engines/data.
COPY scripts/prepare-container-runtime.py /usr/local/share/workstep-runtime/prepare.py
RUN python /usr/local/share/workstep-runtime/prepare.py /root/.workstep/runtime/base \
    && rm /usr/local/share/workstep-runtime/prepare.py \
    && tar -C /root/.workstep/runtime -cf /usr/local/share/workstep-runtime/base.tar base \
    && sha256sum /usr/local/share/workstep-runtime/base.tar | cut -d ' ' -f 1 \
       > /usr/local/share/workstep-runtime/base.sha256
COPY --chmod=755 scripts/container-entrypoint.sh /usr/local/bin/workstep-entrypoint

# Persist /root as one HOME mount; mount project roots separately.

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8765/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/workstep-entrypoint"]
CMD ["/app/apps/daemon/.venv/bin/python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765"]
