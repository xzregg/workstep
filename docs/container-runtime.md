# 容器 Home 与运行时持久化

Dockerfile 支持将用户选择的沙箱目录下的 `home/` 整体挂载为 `/root`。
不使用宿主机的真实 Home；项目目录单独挂载到 `/data/projects`。

```text
沙箱目录/
├─ podman/                    后续桌面端管理的 Podman 与虚拟机，不能挂进容器
├─ desktop/                   后续桌面端管理配置与日志
└─ home/                      挂载到容器 /root
   ├─ .workstep/
   │  └─ runtime/
   │     ├─ base/             镜像管理的 Python、Node、npm、uv 与 Git
   │     ├─ volta/            Volta 工具、下载的 Node 与用户配置
   │     ├─ npm/              应用内安装的 npm 引擎
   │     └─ python-packages/  应用内安装的 Python SDK
   ├─ .codex/
   ├─ .claude/
   ├─ .agents/
   ├─ .cache/uv/
   └─ .npm/                   npm 缓存
```

`podman/`、`desktop/` 由桌面沙箱管理器管理，设置入口支持下载准备、挂载列表及
引擎配置导入；发布与各平台验证要求见 [桌面沙箱模式](desktop-sandbox.md)。
项目的 `.workstep/workstep.db`、事件日志和产物仍在项目目录内。

桌面非沙箱模式默认使用宿主机 `~/.workstep/runtime/`，受管理 npm CLI、Python SDK
和 uv 下载的解释器与此处采用相同的相对目录。桌面 daemon 的基础 Python 随安装包
分发，容器的基础 Python 则由镜像初始化到 `runtime/base/python`；两者不共享二进制。
引擎自身的 `.codex`、`.claude` 等配置仍位于各自 Home 下。

## 镜像启动

镜像将基础运行时打包在 `/usr/local/share/workstep-runtime/base.tar`，
入口 `/usr/local/bin/workstep-entrypoint` 不依赖 Home 里的 Python 或 Node：

构建时将 Python 的 terminfo 数据转换为 ncurses 支持的十六进制目录，
避免 macOS/Windows 大小写不敏感挂载目录中的文件名冲突。

1. 获取 Home 内的初始化锁；目录可以为空，也可以已有引擎配置。
2. 对比镜像安装包摘要与 `runtime/base/.image-sha256`；相同时复用当前环境。
3. 首次初始化或镜像基础运行时变化时，校验摘要并在 Home 内解包到临时目录，
   成功后替换 `base/`。中断后可以恢复上一份基础运行时。
4. 更新 Volta 自身的可执行文件，保留其下载目录和用户配置。
5. 使用镜像构建时锁定的共享 Python 虚拟环境执行命令，不在启动时重新解析依赖。

## 同一镜像启动 WorkStep 或 Gateway

### 前端依赖下载源

Docker 构建中的 npm、Corepack 与三个前端的 Yarn 安装默认使用
`https://registry.npmmirror.com`。安装前仅替换镜像内 `yarn.lock` 的官方源下载地址，
保留依赖版本、完整性校验与 `--frozen-lockfile`；仓库锁文件不变。

直接重新构建即可使用国内源，无需清理已有构建缓存：

```bash
docker build -t workstep:latest .
# 或仅构建 Compose 镜像
docker-compose -f docker-compose.yaml build workstep
```

需要切回官方源或使用其他兼容的 npm 镜像时，通过构建参数覆盖：

```bash
docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org -t workstep:latest .
docker-compose -f docker-compose.yaml build --build-arg NPM_REGISTRY=https://registry.npmjs.org workstep
```

此参数只控制前端依赖下载，不改变基础镜像、系统包与 Python 运行时的下载源。

### 服务配置

Compose 使用显式 `version: "3.7"`，按 Docker Engine 19.03.13 / API 1.40 的语法范围维护，
命令使用旧版 `docker-compose`（兼容 1.24.0）；新版也可使用 `docker compose`。
Dockerfile 不依赖 `$BUILDPLATFORM`、`COPY --chmod` 或 BuildKit 专用指令，入口执行权限
通过普通 `RUN chmod` 设置。引擎版本与 Compose 版本是两个独立版本号。

`workstep:latest` 包含 daemon、Gateway 后端、WorkStep Web、Gateway 门户、Gateway
工作台构建和官网。两个后端共用镜像内 `/app/apps/daemon/.venv`，公共依赖只安装一次；
应用源码、服务入口和数据目录保持独立。

`docker-compose.yaml` 提供两个独立 service，共用相同镜像和构建配置：

| service | 启动入口 | 默认访问地址 | Home 挂载 |
|---|---|---|---|
| `workstep` | `main:app` | `http://localhost:8755` | `./data/home:/root` |
| `gateway` | `gateway.app:app` | `http://localhost:8700` | `./data/gateway-home:/root` |

网关配置默认整块注释，直接启动只运行 WorkStep。需要网关时，先取消
`docker-compose.yaml` 中 `gateway` 配置块的注释，再同时启动：

```bash
docker-compose -f docker-compose.yaml up -d --build
```

单独启动 WorkStep 或网关（网关命令须先启用配置块）：

```bash
docker-compose -f docker-compose.yaml up -d --build workstep
docker-compose -f docker-compose.yaml up -d --build gateway
```

指定 service 不会停止另一个已运行的 service；停止时执行 `docker-compose -f docker-compose.yaml stop workstep`
或 `docker-compose -f docker-compose.yaml stop gateway`。两者没有启动依赖，均在各自容器内监听 8765 并使用
`/api/health` 健康检查。用户可修改各自 `command`，无需更换镜像。

网关端口可用 `WORKSTEP_GATEWAY_PORT` 修改，Home 可用 `WORKSTEP_GATEWAY_HOME` 修改。
网关本机默认外部地址是 `http://localhost:8700`；修改宿主端口或远程部署时，须同步设置
`WORKSTEP_GATEWAY_PUBLIC_ORIGIN` 为实际访问地址，公开部署使用 HTTPS。部署时设置稳定的
`WORKSTEP_GATEWAY_GATEWAY_ID`，例如 `production-gateway`。这些变量可以在 `.env`
中配置，也可直接修改 Compose 中的 `environment`。

Gateway 数据库和签名私钥位于 `/root/.workstep-gateway/`，由网关独立 Home 挂载持久化，
重建容器继续使用。两个容器分别持久化运行时和应用数据，不挂载同一个 Home。

网关补充依赖记录在 `scripts/container-gateway-requirements.txt`，以 daemon 的
`uv.lock` 为版本约束生成。修改后端依赖或锁文件后执行
`python3 scripts/lock-container-gateway.py` 重新生成，再构建镜像；构建时
`uv pip check` 校验两个应用的依赖兼容性，启动时不安装包。

`python3 scripts/verify-shared-image.py workstep:latest` 在临时、无凭据 Home 下验证
两种启动命令、健康检查、页面、共享依赖和重建后的网关私钥保留；测试容器自动删除。

`base/` 由镜像管理，镜像更新时可能替换；用户安装的引擎和包应放在同级的
`npm/`、`python-packages/` 或 `volta/`，不能写入 `base/`。
镜像更新不覆盖 `.codex`、`.claude`、WorkStep 配置和这些用户安装目录。
宿主与容器只共享数据文件，Windows/macOS 的原生 Python/Node 环境不能直接
作为容器的 Linux 运行时。不要让不同镜像版本的运行中容器共享一个 Home。

## 挂载方式

以下片段展示新的挂载结构，宿主目录须提前创建：

```yaml
services:
  workstep:
    image: workstep:latest
    ports:
      - "127.0.0.1:8755:8765"
    volumes:
      - ./data/home:/root
      - ${WORKSTEP_PROJECTS_DIR:-./data/projects}:/data/projects
```

仓库的 `docker-compose.yaml` 已使用整体 Home 挂载，但不会自动迁移现有数据。
采用新结构时，需要把旧的 `data/workstep`、`data/engines/codex`、
`data/engines/claude`、`data/engines/agents` 分别迁移到新 Home 的
`.workstep`、`.codex`、`.claude`、`.agents`；旧 `data/engines/npm`
与 `data/engines/python` 分别迁移到 `.workstep/runtime/npm` 与
`.workstep/runtime/python-packages`。迁移应在原容器停止并完成备份后进行。
旧 npm 可执行文件若引用旧绝对路径，需要在新环境重新安装。

重启、删除并重建容器时，使用相同的两个挂载即可保留 Home 和项目数据。
`apt install` 等写入 Home 外的系统安装不在持久化保证内；此类依赖应加入镜像。

## 验证

`scripts/tests/test_container_entrypoint.py` 使用 Linux 的真实 `flock`、`tar`
和子进程验证空 Home、复用、更新保留用户数据、损坏安装包、中断恢复及锁竞争。
可在具备 Python 的 Linux 环境运行：

```bash
python -m unittest discover -s scripts/tests -p test_container_entrypoint.py
```

镜像检查还需在空 Home 挂载下验证 Python、Node、npm、uv、Volta、Git 和 daemon
模块导入，并以相同 Home 重建容器确认数据保留。此检查无需启动常驻服务。
