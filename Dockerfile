# syntax=docker/dockerfile:1

# ============================================================
# 阶段 1：前端构建（web + landing）
# 基础镜像 node:24-bookworm —— 完整 Node.js 24（corepack 激活 yarn）+ Python 3.11 + git/curl
# ============================================================
FROM node:24-bookworm AS web-build

WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/yarn.lock ./
RUN corepack enable && corepack prepare yarn@1.22.22 --activate && yarn install --frozen-lockfile
COPY apps/web ./
RUN yarn build

WORKDIR /app/apps/landing
COPY apps/landing/package.json apps/landing/yarn.lock ./
RUN corepack enable && corepack prepare yarn@1.22.22 --activate && yarn install --frozen-lockfile
COPY apps/landing ./
RUN yarn build

# ============================================================
# 阶段 2：运行时镜像
# - 完整 Node.js 24 + npm：LLM 引擎（Codex CLI / Claude Code 等）由应用内按需安装
# - Python 3.14：由 uv 自动管理解释器（ENV UV_PYTHON=3.14）
# - daemon（FastAPI）+ 前端构建产物（daemon 以相对路径托管）
# ============================================================
FROM node:24-bookworm

# uv —— Python 依赖与解释器管理
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# 引擎应用内按需安装所需的运行时（勿裁剪）：
# - npm：Codex CLI / Claude Code（npm install -g ...）
# - uv：Python SDK 引擎（uv pip install --python <daemon 解释器> ...）
# - git / curl / 编译工具链：node:24-bookworm 基础镜像自带（buildpack-deps）
RUN npm --version && uv --version && git --version && curl --version | head -1

# 后端依赖（uv.lock 已入库；Docker 内固定 Python 3.14，由 uv 自动下载解释器）
ENV UV_PYTHON=3.14
WORKDIR /app/apps/daemon
COPY apps/daemon/pyproject.toml apps/daemon/uv.lock apps/daemon/.python-version ./
RUN uv sync --no-dev --frozen

# 后端源码
COPY apps/daemon ./

# 前端构建产物（settings.py 中 web_dist=../web/dist、landing_dist=../landing/dist）
COPY --from=web-build /app/apps/web/dist ../web/dist
COPY --from=web-build /app/apps/landing/dist ../landing/dist

# 数据 / 配置 / 会话目录：~/.workstep、~/.codex、~/.claude
VOLUME ["/root/.workstep", "/root/.codex", "/root/.claude"]

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8765/api/health || exit 1

CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765"]
