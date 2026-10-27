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

## 日志与崩溃排查

桌面应用的「帮助」菜单和托盘菜单提供「打开日志目录」「导出诊断包」；本地后台启动失败的弹窗也可打开日志目录。日志位于 Electron `userData` 目录下的 `logs/`，通常为 macOS 的 `~/Library/Application Support/WorkStep/logs/`、Windows 的 `%APPDATA%/WorkStep/logs/` 或 Linux 的 `~/.config/WorkStep/logs/`，以菜单打开的实际路径为准。

- `desktop.log`：启动、主进程控制台、页面加载失败、页面／GPU 等进程退出及沙箱阶段信息。
- `daemon.log`：普通桌面包内置后台的 stdout/stderr、退出码、退出信号和是否属于正常停止。开发模式连接外部服务，不收集外部服务日志。
- `fatal.log`：主进程未捕获异常及导致退出的未处理 Promise 拒绝；记录后保留原有致命退出行为。
- `crashes/`：Electron 原生崩溃转储，仅保存在本机，不上传。它不覆盖 Python 后台的原生崩溃，也不保证记录强制结束或启动前被操作系统拦截的情况。

普通内置后台的启动就绪等待上限为 120 秒，以容纳 Windows 首次冷启动；超过上限会终止该后台并显示启动失败。若日志出现 `CLI runtime directory ACL must be owner-private`，查看同一时段的 `CLI Windows ACL` 警告，其中记录权限校验失败或 PowerShell 超时原因。

普通文本日志单文件最多 5 MiB，各保留三份轮转备份；致命异常日志保留一份备份，桌面文本日志合计最多 50 MiB。超长单条记录按字节截断，重启后继续轮转，不为每次启动新增日志文件。写入异步排队，队列满时省略部分记录；仅致命退出前的最后记录同步落盘。磁盘不可写时不阻止应用运行，但无法保证日志保存。

原生 `.dmp` 转储保留最近 14 天、最多 10 份，总大小最多 100 MiB；启动时、进程退出事件后及每小时异步清理，优先保留最新报告。修改不足一分钟的转储暂时保留，避免删除仍在写入的报告，因此清理间隔和写入保护期间可能暂时超限。清理只处理转储文件，不跟随符号链接，不删除 Crashpad 的运行元数据。

沙箱 `desktop/sandbox.log` 同样按 5 MiB、三份备份轮转；`desktop/daemon.log` 为覆盖写入的快照，最多 5 MiB。新启动的 Podman 容器显式使用 `k8s-file` 日志驱动和 `max-size=10mb` 限制，避免仅限制导出的快照、却让容器底层日志无限累积，参数见 [Podman 文档](https://docs.podman.io/en/stable/markdown/podman-run.1.html)。用户自行保存的诊断包不会被自动删除。

导出生成 `.json.gz` 压缩诊断包，包含版本、操作系统／架构信息、桌面文本日志，以及可读取的沙箱诊断快照。运行时桌面令牌、已知本机会话凭据及常见认证字段在写入和导出时脱敏；不主动读取项目数据库、聊天记录、配置文件或原生转储。文本错误仍可能包含业务路径或第三方输出，分享前可解压检查。需要原生转储时，从 `crashes/` 单独取出。

实现位于 `src/diagnostics.cjs`，桌面生命周期接入位于 `src/main.cjs`，普通后台输出由 `src/sidecar.cjs` 接入；回归覆盖日志轮转／脱敏、导出白名单、磁盘错误、慢磁盘响应、真实后台退出、真实致命异常以及菜单操作。

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

本机 macOS ARM64 试用包可在仓库根直接运行 `./apps/desktop/package-local-macos.sh 1.0.9`。脚本会更新桌面版本、从 Web favicon 重新生成图标、构建 Web 和内置后台、注入资源、生成带版本号的 DMG，并完成 ad-hoc 签名校验与 SHA-256 输出；省略版本号时使用 `apps/desktop/package.json` 中的当前版本。打包前会清理旧 macOS DMG/ZIP，避免误用历史包。Electron Builder 生成 DMG 时需要临时创建 `WorkStep.app`，脚本会在校验后删除该目录，不把它作为独立产物保留。该命令关闭 hardened runtime，不使用开发者证书或公证。Electron fuses 会修改可执行文件，不能只跳过签名后直接分发，否则可能因签名页不匹配在启动前被 macOS 终止。正式 Developer ID 发布应继续使用默认 hardened runtime 与证书签名配置。

## 发布

统一版本修改、提交与标签要求见 [发布规范](../../docs/releasing.md#统一应用版本号)。

所有桌面打包入口都会校验沙箱镜像清单。在线发布前将可匿名拉取的 GHCR 镜像摘要设置为 `SANDBOX_IMAGE`，在 `apps/desktop` 执行 `node scripts/write-sandbox-release.cjs`。本地试用包使用明确的 `{"image":null,"localDocker":true}` 清单，仅支持从已启动的 Docker 扫描、选择并导入兼容的 WorkStep 镜像。未明确启用本地导入的空清单或仅含 `latest` 等标签的在线清单会阻止打包；已安装的桌面包不会读取开发用的 `WORKSTEP_SANDBOX_IMAGE` 覆盖变量。

内置 Python 启动时禁用字节码缓存写入，避免改变已签名的应用包资源；验收时应在实际启动前后分别检查签名。

根目录的 `build.sh` 可先构建 Web dist，再生成桌面后端包：

```bash
./build.sh              # 构建 web dist 后打包桌面后端
./build.sh web          # 只构建 web dist
./build.sh --with-web   # 构建 web dist 后打包桌面后端
./build.sh --no-web     # 复用已有 apps/web/dist
```

推送 `v*` tag 后，CI 在 Windows x64、macOS ARM64、macOS Intel x64 和 Linux x64 分别完成以下流程；安装包内置与自身架构一致的 CPython。Mac ARM64 使用 `macos-15`，Intel 使用 `macos-15-intel` 原生构建；两者分别产出 `WorkStep-macos-arm64.dmg` 和 `WorkStep-macos-x64.dmg`，不能混用。Mac 上传前从真实 DMG 安装到临时目录，验证架构、签名、首次启动、后台版本、认证、UTF-8 配置持久化与重启退出；实机 Gatekeeper、既有安装升级和真实模型／沙箱仍需另行验收：

1. 构建 React 前端。
2. 下载可重定位的 CPython，并安装锁定的基础 `requirements-prod.txt`（不含可点击安装的引擎 SDK）。
3. 生成 `build-artifacts/{win,mac,linux}/backend/main.dist/`，其中包含 Python runtime 与 daemon 源码。
4. 把完整 standalone 目录注入 Electron 的 `resources/backend/`。
5. 生成 NSIS `.exe`、`.dmg`/更新用 `.zip`、`.AppImage` 和更新元数据。
6. Windows 实际安装包通过安装、启动、界面、版本、重启／升级数据保留和卸载自动验收，失败时阻止发布；报告与真实截图上传为测试证据。
7. 创建草稿 GitHub Release；人工发布后才会成为客户端可检测的新版本。

已发布 Windows 安装包的独立补测方法及未覆盖的实机项目见 [Windows 安装包自动验收](../../docs/releasing.md#windows-安装包自动验收)。

桌面端不自动下载或安装更新。正式包启动时最多每天查询一次 GitHub 最新 Release，并把结果缓存在本机；用户也可以在“设置 → 系统设置 → 桌面更新”中手动检查。发现更高版本后，只显示“前往 GitHub 下载”按钮并用系统浏览器打开 Release 页面。仅推送 `main` 不会触发更新，必须发布版本号更高的 GitHub Release。

生产 sidecar 每次启动都会生成新的随机令牌。令牌只保留在 Electron 主进程与 sidecar 环境中，由主进程为桌面后台的 HTTP/WebSocket 请求注入；渲染进程不会获得令牌。沙箱和非沙箱模式都首选宿主机端口 `8766`，冲突时才回退到空闲端口。后台监听宿主机网络接口，但远程访问未开启时业务 API 仍要求桌面令牌；开启后，局域网浏览器再按远程访问设置及访问密钥鉴权。外部导航、新窗口、WebView 和浏览器权限请求均由桌面壳限制。

LLM 回复或任务步骤执行完成、失败且窗口不在前台时，网页通过受限 preload 桥接请求 Electron 系统通知；通知点击后打开对应会话或任务。桥接只接受已加载的本地服务来源，浏览器通知权限仍保持禁用。

后端包的 `legal/` 目录包含 `LICENSE`、`NOTICE`、第三方说明和 CycloneDX SBOM。当前 GitHub Release 产出 Windows 与 macOS 未签名早期构建，不需要证书或 Apple 公证账号。

Windows 构建使用隐藏子进程窗口并保留 stdout 管道，以便 `PORT:<port>` 就绪协议可靠传回主进程。

未签名构建会触发 Windows SmartScreen 或 macOS Gatekeeper 提示；macOS 用户可能需要在“系统设置 → 隐私与安全性”中明确允许首次打开。未签名构建不应承诺无提示自动更新，升级时应重新下载并人工确认。

## 沙箱模式

设置 → 沙箱提供 Podman 自动下载、Home 与项目挂载、引擎配置导入和重启切换。独立存储集中在用户选择的沙箱目录，沙箱 Home 使用相同的 `.workstep/runtime` 相对结构。支持的平台、镜像发布配置、系统前置条件和实机验收见 [桌面沙箱模式](../../docs/desktop-sandbox.md)。开发测试镜像可通过 `WORKSTEP_SANDBOX_IMAGE` 指定；生产桌面使用发布时固定的镜像摘要。
