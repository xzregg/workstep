# WorkStep Desktop

桌面版 WorkStep —— 用 [pywebview](https://pywebview.flowrl.com/)（原生 WebView 窗口）+ [PyInstaller](https://pyinstaller.org/)（Python 打包）把后端 daemon、已编译前端和模板数据打成一个跨平台绿色应用。

```text
WorkStep.app / WorkStep.exe（原生窗口）
  └─ 内嵌 daemon（FastAPI，127.0.0.1:<port>）
       ├─ 前端静态资源（apps/web 编译产物，随包分发）
       ├─ data/templates 等种子数据（写入 ~/.workstep/data/templates/）
       └─ 引擎（SDK 引擎随包，CLI 引擎运行时检测）
```

## 特性

- **单进程**：daemon 在应用内线程运行，关闭窗口即优雅退出；日志写入 `~/.workstep/logs/desktop.log`。
- **单实例**：默认端口 8765；若已有 WorkStep daemon 在运行则复用，否则自动换用空闲端口。
- **数据安全**：所有数据/配置写 `~/.workstep/`，应用包本身只读。
- **引擎**：Codex SDK 运行时（约 300MB）随包内置，开箱可用；`codex`/`claude` CLI 等外部命令引擎需用户自行安装，应用运行时自动检测。

## 构建

PyInstaller 不支持交叉编译：**macOS 包在 macOS 构建，Windows 包在 Windows 构建**。

macOS / Linux：

```bash
cd apps/desktop
./build.sh
# 产物：apps/desktop/dist/WorkStep-macOS-<版本>.zip（.app 应用）
```

Windows（PowerShell）：

```powershell
cd apps\desktop
.\build.ps1
# 产物：apps\desktop\dist\WorkStep-Windows-<版本>.zip（免安装目录）
```

脚本内部流程：`npm ci && npm run build`（编译前端）→ `uv sync --group desktop`（安装 pywebview / pyinstaller）→ PyInstaller 打包 → 压缩产物。

## 运行

- 解压后双击 `WorkStep.app`（macOS）或 `WorkStep.exe`（Windows）。
- 首次启动 macOS 未签名应用：右键应用 → 打开（或系统设置 → 隐私与安全性 → 仍要打开）；Windows SmartScreen 选择「更多信息 → 仍要运行」。
- 窗口加载 `http://127.0.0.1:<port>/`，同时可直接在浏览器访问同一地址。

## 开发与冒烟

无窗口启动 daemon（打包后验证用）：

```bash
cd apps/desktop
dist/WorkStep.app/Contents/MacOS/WorkStep --serve-only --port 18765
curl http://127.0.0.1:18765/api/health
```

源码模式（不打包，直接跑窗口）：

```bash
cd apps/daemon && uv sync --group desktop
uv run python ../desktop/desktop_main.py            # 打开窗口
uv run python ../desktop/desktop_main.py --serve-only --port 18765
```

`--port` 覆盖端口；`--host` 覆盖绑定地址（默认 `127.0.0.1`）。

## 说明

- 前端与 daemon 业务代码零改动：前端本就同源相对路径 `/api`、`/ws`，由 daemon 静态托管。
- 打包体积主要来自随包的 Codex CLI 运行时（`codex_cli_bin`，约 300MB）；不需要 Codex SDK 引擎时可在 `workstep_desktop.spec` 的 `collect_all` 列表中移除 `codex_cli_bin` 以显著减小体积。
- 未签名、未公证，适用于内部分发；正式分发请另行配置签名（Apple Developer ID / Windows 证书）。
