# WorkStep Desktop

Electron 桌面壳负责窗口、安装包和自动更新；FastAPI daemon 运行在随应用分发的独立 Python runtime 中，用户机器无需安装 Python。Codex SDK、Claude Agent SDK 等可选引擎不随桌面包预装，用户点击“安装”后写入 `~/.workstep/runtime/python-packages/`，桌面应用升级不会覆盖它们。

非沙箱模式的受管理安装统一使用 `~/.workstep/runtime/`（设置 `WORKSTEP_CONFIG_DIR` 时跟随该配置目录）：npm CLI 放在 `npm/`，Python SDK 放在 `python-packages/`，uv 新下载的解释器放在 `base/python/`，uv 安装目标为 `base/bin/`。桌面启动时优先查找这些目录，Windows 的 npm 命令入口直接位于 `npm/`，macOS/Linux 位于 `npm/bin/`；引擎子进程也能通过 `PYTHONPATH` 读取 Python SDK。

现有宿主机引擎保留为查找回退，不自动移动或卸载；Node/npm/uv 仍可使用宿主机已有工具，daemon 自带 Python 仍位于安装包内。遇到 Volta 管理的 npm 时，启动阶段解析实际 Node/npm 路径，避免其全局安装拦截把引擎放回宿主机 Volta 目录。沙箱模式使用沙箱 `home/` 作为 Home，相同类型的安装采用同样的相对目录，详见 [容器运行时说明](../../docs/container-runtime.md)。

安装包同时携带 daemon CLI。sidecar 会把 bundled Python、daemon 目录、当前实际端口和临时桌面令牌通过 `WORKSTEP_CLI_PYTHON`、`WORKSTEP_DAEMON_DIR`、`WORKSTEP_DAEMON_URL`、`WORKSTEP_DESKTOP_TOKEN` 传给引擎子进程，因此 Skill 调用 CLI 不依赖用户安装 Python，也不把动态地址或令牌写入项目文件。

```text
Electron
  └─ resources/backend/python/.../python resources/backend/app/main.py --port <port>
       └─ stdout: PORT:<实际端口>
            └─ BrowserWindow 加载 http://127.0.0.1:<实际端口>/
```

## 端口

生产版（原生后台和沙箱）默认优先使用 `127.0.0.1:8766`，仅在端口被占用时改用系统分配的空闲端口。可设置首选端口，也可显式传入 `0` 使用随机端口：

```bash
WorkStep --backend-port=43123
WorkStep --port 43123
WORKSTEP_DESKTOP_PORT=43123 WorkStep
```

启动参数优先于环境变量。首选端口被占用时启动自己的后台并改用空闲端口，不会连接到占用该端口的其他服务；其他启动错误仍显示失败。后台只绑定 `127.0.0.1`。

开发模式不启动二进制 sidecar，默认连接 `http://127.0.0.1:8766`；也可设置 `WORKSTEP_DEV_SERVER_URL`，或使用相同的 `--backend-port` 参数。

## 本地开发

桌面应用和安装包图标以 `apps/web/public/favicon.svg` 为源，与网页品牌图标一致。更新网页图标后，在 `apps/desktop` 执行 `yarn icons`，重新生成 `build/app-icon.svg`、macOS ICNS、Windows ICO 和 Linux 各尺寸 PNG，再重新打包。

先分别启动 daemon 和 Web 开发服务，再启动 Electron：

```bash
cd apps/desktop
corepack yarn install --frozen-lockfile
WORKSTEP_DEV_SERVER_URL=http://127.0.0.1:5173 corepack yarn start
```

生产安装包只在 GitHub Actions 对应平台 Runner 上构建。本地测试不会启动常驻服务：

```bash
cd apps/desktop && corepack yarn test
uv run --project apps/daemon --group dev pytest apps/desktop/tests/test_backend_entry.py
```

本机 macOS ARM64 试用包：先在仓库根运行 `./build.sh --with-web`，再在 `apps/desktop` 运行 `BUILD_PLATFORM=mac ./inject-backend.sh` 和 `yarn dist:mac:local`。该命令显式使用 ad-hoc 签名并关闭 hardened runtime，不使用开发者证书或公证；构建后用 `codesign --verify --deep --strict dist/mac-arm64/WorkStep.app` 检查。Electron fuses 会修改可执行文件，不能只跳过签名后直接分发，否则可能因签名页不匹配在启动前被 macOS 终止。正式 Developer ID 发布应继续使用默认 hardened runtime 与证书签名配置。

## 发布

所有桌面打包入口都会校验沙箱镜像清单。在线发布前将可匿名拉取的 GHCR 镜像摘要设置为 `SANDBOX_IMAGE`，在 `apps/desktop` 执行 `node scripts/write-sandbox-release.cjs`。本地试用包使用明确的 `{"image":null,"localDocker":true}` 清单，仅支持从已启动的 Docker 扫描、选择并导入兼容的 WorkStep 镜像。未明确启用本地导入的空清单或仅含 `latest` 等标签的在线清单会阻止打包；已安装的桌面包不会读取开发用的 `WORKSTEP_SANDBOX_IMAGE` 覆盖变量。

内置 Python 启动时禁用字节码缓存写入，避免改变已签名的应用包资源；验收时应在实际启动前后分别检查签名。

根目录的 `build.sh` 可先构建 Web dist，再生成桌面后端包：

```bash
./build.sh              # 构建 web dist 后打包桌面后端
./build.sh web          # 只构建 web dist
./build.sh --with-web   # 构建 web dist 后打包桌面后端
./build.sh --no-web     # 复用已有 apps/web/dist
```

推送 `v*` tag 后，CI 在 Windows x64、Windows x86（32 位）、macOS 和 Linux 分别完成以下流程；Windows 安装包内置与自身架构一致的 CPython：

1. 构建 React 前端。
2. 下载可重定位的 CPython，并安装锁定的基础 `requirements-prod.txt`（不含可点击安装的引擎 SDK）。
3. 生成 `build-artifacts/{win,mac,linux}/backend/main.dist/`，其中包含 Python runtime 与 daemon 源码。
4. 把完整 standalone 目录注入 Electron 的 `resources/backend/`。
5. 生成 NSIS `.exe`、`.dmg`/更新用 `.zip`、`.AppImage` 和更新元数据。
6. 创建草稿 GitHub Release；人工发布后客户端才会收到更新。

更新下载完成后不会直接退出应用。桌面壳先检查所有项目是否仍有运行中的任务或会话；繁忙时只提示稍后更新，空闲时也必须由用户确认，之后才执行：停止 sidecar → 等待进程退出 → 额外等待 500ms → `quitAndInstall`。

生产 sidecar 每次启动都会生成新的随机令牌。令牌只保留在 Electron 主进程与 sidecar 环境中，由主进程为桌面后台的 HTTP/WebSocket 请求注入；渲染进程不会获得令牌。沙箱和非沙箱模式都首选宿主机端口 `8766`，冲突时才回退到空闲端口。后台监听宿主机网络接口，但远程访问未开启时业务 API 仍要求桌面令牌；开启后，局域网浏览器再按远程访问设置及访问密钥鉴权。外部导航、新窗口、WebView 和浏览器权限请求均由桌面壳限制。

LLM 回复或任务步骤执行完成、失败且窗口不在前台时，网页通过受限 preload 桥接请求 Electron 系统通知；通知点击后打开对应会话或任务。桥接只接受已加载的本地服务来源，浏览器通知权限仍保持禁用。

后端包的 `legal/` 目录包含 `LICENSE`、`NOTICE`、第三方说明和 CycloneDX SBOM。当前 GitHub Release 产出 Windows 与 macOS 未签名早期构建，不需要证书或 Apple 公证账号。

Windows 构建使用隐藏子进程窗口并保留 stdout 管道，以便 `PORT:<port>` 就绪协议可靠传回主进程。

未签名构建会触发 Windows SmartScreen 或 macOS Gatekeeper 提示；macOS 用户可能需要在“系统设置 → 隐私与安全性”中明确允许首次打开。未签名构建不应承诺无提示自动更新，升级时应重新下载并人工确认。

## 沙箱模式

设置 → 沙箱提供 Podman 自动下载、Home 与项目挂载、引擎配置导入和重启切换。独立存储集中在用户选择的沙箱目录，沙箱 Home 使用相同的 `.workstep/runtime` 相对结构。支持的平台、镜像发布配置、系统前置条件和实机验收见 [桌面沙箱模式](../../docs/desktop-sandbox.md)。开发测试镜像可通过 `WORKSTEP_SANDBOX_IMAGE` 指定；生产桌面使用发布时固定的镜像摘要。
