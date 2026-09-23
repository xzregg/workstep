# WorkStep Desktop

Electron 桌面壳负责窗口、安装包和自动更新；FastAPI daemon 运行在随应用分发的独立 Python runtime 中，用户机器无需安装 Python。Codex SDK、Claude Agent SDK 等可选引擎不随桌面包预装，用户点击“安装”后写入 `~/.workstep/runtime/python-packages/`，桌面应用升级不会覆盖它们。

安装包同时携带 daemon CLI。sidecar 会把 bundled Python、daemon 目录、当前随机端口和临时桌面令牌通过 `WORKSTEP_CLI_PYTHON`、`WORKSTEP_DAEMON_DIR`、`WORKSTEP_DAEMON_URL`、`WORKSTEP_DESKTOP_TOKEN` 传给引擎子进程，因此 Skill 调用 CLI 不依赖用户安装 Python，也不把动态地址或令牌写入项目文件。

```text
Electron
  └─ resources/backend/python/.../python resources/backend/app/main.py --port <port>
       └─ stdout: PORT:<实际端口>
            └─ BrowserWindow 加载 http://127.0.0.1:<实际端口>/
```

## 端口

生产版默认传入 `--port 0`，由操作系统分配空闲端口，不依赖固定的 8765。需要固定端口时可用：

```bash
WorkStep --backend-port=43123
WorkStep --port 43123
WORKSTEP_DESKTOP_PORT=43123 WorkStep
```

启动参数优先于环境变量。固定端口被占用时，应用显示启动失败，不会错误连接到占用该端口的其他服务。后台只绑定 `127.0.0.1`。

开发模式不启动二进制 sidecar，默认连接 `http://127.0.0.1:8765`；也可设置 `WORKSTEP_DEV_SERVER_URL`，或使用相同的 `--backend-port` 参数。

## 本地开发

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

## 发布

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

生产 sidecar 每次启动都会生成新的随机令牌。令牌只保留在 Electron 主进程与 sidecar 环境中，由主进程为目标 loopback origin 的 HTTP/WebSocket 请求注入；渲染进程不会获得令牌。外部导航、新窗口、WebView 和浏览器权限请求均由桌面壳限制。

后端包的 `legal/` 目录包含 `LICENSE`、`NOTICE`、第三方说明和 CycloneDX SBOM。当前 GitHub Release 产出 Windows 与 macOS 未签名早期构建，不需要证书或 Apple 公证账号。

Windows 构建使用隐藏子进程窗口并保留 stdout 管道，以便 `PORT:<port>` 就绪协议可靠传回主进程。

未签名构建会触发 Windows SmartScreen 或 macOS Gatekeeper 提示；macOS 用户可能需要在“系统设置 → 隐私与安全性”中明确允许首次打开。未签名构建不应承诺无提示自动更新，升级时应重新下载并人工确认。
