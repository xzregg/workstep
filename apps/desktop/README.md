# WorkStep Desktop

Electron 桌面壳负责窗口、安装包和自动更新；FastAPI daemon 运行在随应用分发的独立 Python runtime 中，用户机器无需安装 Python。Codex SDK、Claude Agent SDK 等可选引擎不随桌面包预装，用户点击“安装”后写入 `~/.workstep/runtime/python-packages/`，桌面应用升级不会覆盖它们。

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
yarn install
WORKSTEP_DEV_SERVER_URL=http://127.0.0.1:5173 yarn start
```

生产安装包只在 GitHub Actions 对应平台 Runner 上构建。本地测试不会启动常驻服务：

```bash
cd apps/desktop && yarn test
uv run --project apps/daemon --group dev pytest apps/desktop/tests/test_backend_entry.py
```

## 发布

推送 `v*` tag 后，CI 在 Windows、macOS 和 Linux 分别完成以下流程：

1. 构建 React 前端。
2. 下载可重定位的 CPython，并安装锁定的基础 `requirements-prod.txt`（不含可点击安装的引擎 SDK）。
3. 生成 `build-artifacts/{win,mac,linux}/backend/main.dist/`，其中包含 Python runtime 与 daemon 源码。
4. 把完整 standalone 目录注入 Electron 的 `resources/backend/`。
5. 生成 NSIS `.exe`、`.dmg`/更新用 `.zip`、`.AppImage` 和更新元数据。
6. 创建草稿 GitHub Release；人工发布后客户端才会收到更新。

更新安装严格执行：停止 sidecar → 等待进程退出 → 额外等待 500ms → `quitAndInstall`。macOS 自动更新要求正式发布包完成代码签名。

Windows 构建使用 `--windows-console-mode=attach`，由 Electron 的 `windowsHide` 隐藏窗口并保留 stdout 管道；若使用 `disable`，`PORT:<port>` 就绪协议无法可靠传回主进程。
