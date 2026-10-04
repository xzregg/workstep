# ============================================================
# 阶段 1：前端构建（web + landing）
# 完整 node:24-bookworm 提供 yarn（corepack）与编译工具，产物仅拷贝进最终镜像
# ============================================================
FROM node:24-bookworm AS web-build

WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/yarn.lock ./
RUN sed -i 's#https://registry.yarnpkg.com#https://registry.npmmirror.com#g; s#https://registry.npmjs.org#https://registry.npmmirror.com#g' yarn.lock \
    && npm config set registry https://registry.npmmirror.com \
    && corepack enable && corepack prepare yarn@1.22.22 --activate \
    && yarn config set registry https://registry.npmmirror.com \
    && yarn install --frozen-lockfile
COPY apps/web ./
RUN yarn build

WORKDIR /app/apps/landing
COPY apps/landing/package.json apps/landing/yarn.lock ./
RUN sed -i 's#https://registry.yarnpkg.com#https://registry.npmmirror.com#g; s#https://registry.npmjs.org#https://registry.npmmirror.com#g' yarn.lock \
    && npm config set registry https://registry.npmmirror.com \
    && corepack enable && corepack prepare yarn@1.22.22 --activate \
    && yarn config set registry https://registry.npmmirror.com \
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
    && make prefix=/opt/git NO_GETTEXT=YesPlease NO_TCLTK=YesPlease -j"$(nproc)" all \
    && make prefix=/opt/git NO_GETTEXT=YesPlease NO_TCLTK=YesPlease install

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
COPY --from=git-build /opt/git /opt/git
ENV PATH="/opt/git/bin:${PATH}"

RUN npm config set registry https://registry.npmmirror.com

# Volta 可在容器内直接调用；保留基础镜像的 Node/npm 与引擎安装路径优先级。
ENV VOLTA_HOME=/root/.volta \
    PATH="${PATH}:/root/.volta/bin"
RUN curl -fsSL https://get.volta.sh | bash -s -- --skip-setup \
    && volta --version

# uv —— Python 依赖与解释器管理；UV_CACHE_DIR 指向 /tmp 便于构建后清理
ENV UV_PYTHON=3.14 \
    UV_CACHE_DIR=/tmp/uv-cache \
    UV_LINK_MODE=copy \
    PATH="/root/.local/bin:${PATH}"
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
    && rm -rf /tmp/uv-cache

# 引擎安装到独立持久化目录；不挂载镜像的 Node/Python 运行环境。
ENV NPM_CONFIG_PREFIX=/opt/workstep-engines/npm \
    WORKSTEP_ENGINE_PACKAGE_DIR=/opt/workstep-engines/python \
    PYTHONPATH=/opt/workstep-engines/python \
    PATH="/app/apps/daemon/.venv/bin:/opt/workstep-engines/npm/bin:${PATH}"

RUN command -v python && python --version \
    && command -v node && node --version \
    && command -v npm && npm --version \
    && command -v volta && volta --version

# 后端源码（清理字节码缓存）
COPY apps/daemon ./
RUN find /app -name '__pycache__' -type d -prune -exec rm -rf {} + \
    && rm -rf /root/.cache /tmp/uv-cache

# 前端构建产物（settings.py 中 web_dist=../web/dist、landing_dist=../landing/dist）
COPY --from=web-build /app/apps/web/dist ../web/dist
COPY --from=web-build /app/apps/landing/dist ../landing/dist

# 数据、配置、会话与引擎目录由 compose 或 docker run 显式挂载以持久化。

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8765/api/health || exit 1

CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765"]
